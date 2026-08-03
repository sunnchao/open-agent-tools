import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import yauzl, { type Entry, type ZipFile } from "yauzl";

export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxFiles: 10_000,
  maxFileBytes: 25 * 1024 * 1024,
};

export type ArchiveValidationCode =
  | "COMPRESSED_SIZE_LIMIT"
  | "DESTINATION_EXISTS"
  | "DUPLICATE_PATH"
  | "EXPANDED_SIZE_LIMIT"
  | "FILE_COUNT_LIMIT"
  | "FILE_SIZE_LIMIT"
  | "MALFORMED_ARCHIVE"
  | "PATH_CONFLICT"
  | "UNSAFE_PATH"
  | "UNSUPPORTED_COMPRESSION"
  | "UNSUPPORTED_ENTRY_TYPE";

export class ArchiveValidationError extends Error {
  constructor(
    public readonly code: ArchiveValidationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArchiveValidationError";
  }
}

export interface InspectedArchiveEntry {
  path: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ArchiveInspection {
  entries: InspectedArchiveEntry[];
  compressedBytes: number;
  expandedBytes: number;
  limits: ArchiveLimits;
}

function validateLimits(limits: ArchiveLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Archive limits must be positive safe integers");
    }
  }
}

function decodeEntryName(entry: Entry): string {
  const rawName = entry.fileName as unknown;
  if (typeof rawName === "string") {
    return rawName;
  }
  if (!Buffer.isBuffer(rawName)) {
    throw new ArchiveValidationError("MALFORMED_ARCHIVE", "ZIP entry name is invalid");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch (cause) {
    throw new ArchiveValidationError("MALFORMED_ARCHIVE", "ZIP entry name is not valid UTF-8", {
      cause,
    });
  }
}

function normalizeEntryPath(entry: Entry): { path: string; directory: boolean } {
  const originalPath = decodeEntryName(entry);
  if (
    originalPath.length === 0 ||
    originalPath.includes("\0") ||
    originalPath.includes("\\") ||
    originalPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(originalPath)
  ) {
    throw new ArchiveValidationError("UNSAFE_PATH", "ZIP contains an unsafe entry path");
  }

  const directory = originalPath.endsWith("/");
  const withoutTrailingSlash = directory ? originalPath.slice(0, -1) : originalPath;
  const segments = withoutTrailingSlash.split("/");
  if (
    withoutTrailingSlash.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ArchiveValidationError("UNSAFE_PATH", "ZIP contains an unsafe entry path");
  }

  return { path: segments.join("/").normalize("NFC"), directory };
}

function validateEntryType(entry: Entry, directory: boolean): void {
  const madeBy = entry.versionMadeBy >>> 8;
  if (madeBy !== 3) {
    return;
  }

  const mode = entry.externalFileAttributes >>> 16;
  const fileType = mode & 0o170000;
  const expectedType = directory ? 0o040000 : 0o100000;
  if (fileType !== expectedType) {
    throw new ArchiveValidationError(
      "UNSUPPORTED_ENTRY_TYPE",
      "ZIP contains a link or special file",
    );
  }
}

function openArchive(archivePath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      archivePath,
      {
        autoClose: true,
        decodeStrings: false,
        lazyEntries: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error) {
          reject(
            new ArchiveValidationError("MALFORMED_ARCHIVE", "Unable to open ZIP archive", {
              cause: error,
            }),
          );
          return;
        }
        resolvePromise(zipFile);
      },
    );
  });
}

async function forEachEntry(
  archivePath: string,
  visit: (zipFile: ZipFile, entry: Entry) => Promise<void> | void,
): Promise<void> {
  const zipFile = await openArchive(archivePath);

  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(
        error instanceof ArchiveValidationError
          ? error
          : new ArchiveValidationError("MALFORMED_ARCHIVE", "Unable to read ZIP archive", {
              cause: error,
            }),
      );
    };

    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    zipFile.on("entry", (entry: Entry) => {
      Promise.resolve()
        .then(() => visit(zipFile, entry))
        .then(() => zipFile.readEntry(), fail);
    });
    zipFile.readEntry();
  });
}

function validatePathConflicts(entries: InspectedArchiveEntry[]): void {
  const files = entries.filter((entry) => !entry.directory).map((entry) => entry.path);
  const allPaths = new Set(entries.map((entry) => entry.path));

  for (const file of files) {
    const prefix = `${file}/`;
    if ([...allPaths].some((path) => path.startsWith(prefix))) {
      throw new ArchiveValidationError(
        "PATH_CONFLICT",
        "ZIP file path conflicts with a nested entry",
      );
    }
  }
}

export async function inspectZipArchive(
  archivePath: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ArchiveInspection> {
  validateLimits(limits);
  const compressedBytes = (await stat(archivePath)).size;
  if (compressedBytes > limits.maxCompressedBytes) {
    throw new ArchiveValidationError(
      "COMPRESSED_SIZE_LIMIT",
      "ZIP exceeds the compressed size limit",
    );
  }

  const entries: InspectedArchiveEntry[] = [];
  const paths = new Set<string>();
  let expandedBytes = 0;

  await forEachEntry(archivePath, (_zipFile, entry) => {
    if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) {
      throw new ArchiveValidationError(
        "UNSUPPORTED_COMPRESSION",
        "ZIP encryption or compression method is not supported",
      );
    }

    const normalized = normalizeEntryPath(entry);
    validateEntryType(entry, normalized.directory);

    if (paths.has(normalized.path)) {
      throw new ArchiveValidationError("DUPLICATE_PATH", "ZIP contains duplicate paths");
    }
    paths.add(normalized.path);

    if (entries.length + 1 > limits.maxFiles) {
      throw new ArchiveValidationError("FILE_COUNT_LIMIT", "ZIP exceeds the entry count limit");
    }
    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new ArchiveValidationError("FILE_SIZE_LIMIT", "ZIP entry exceeds the file size limit");
    }

    expandedBytes += entry.uncompressedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
      throw new ArchiveValidationError(
        "EXPANDED_SIZE_LIMIT",
        "ZIP exceeds the expanded size limit",
      );
    }

    entries.push({
      path: normalized.path,
      directory: normalized.directory,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    });
  });

  validatePathConflicts(entries);
  return { entries, compressedBytes, expandedBytes, limits: { ...limits } };
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(stream);
    });
  });
}

export async function extractZipArchive(
  archivePath: string,
  destination: string,
  expectedInspection: ArchiveInspection,
): Promise<void> {
  const currentInspection = await inspectZipArchive(archivePath, expectedInspection.limits);
  if (JSON.stringify(currentInspection.entries) !== JSON.stringify(expectedInspection.entries)) {
    throw new ArchiveValidationError(
      "MALFORMED_ARCHIVE",
      "ZIP changed between inspection and extraction",
    );
  }

  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (cause) {
    throw new ArchiveValidationError(
      "DESTINATION_EXISTS",
      "Extraction destination must not already exist",
      { cause },
    );
  }

  const destinationRoot = resolve(destination);
  try {
    await forEachEntry(archivePath, async (zipFile, entry) => {
      const normalized = normalizeEntryPath(entry);
      const outputPath = resolve(destinationRoot, ...normalized.path.split("/"));
      if (!outputPath.startsWith(`${destinationRoot}${sep}`)) {
        throw new ArchiveValidationError("UNSAFE_PATH", "ZIP entry escapes extraction root");
      }

      if (normalized.directory) {
        await mkdir(outputPath, { recursive: true, mode: 0o700 });
        return;
      }

      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      const input = await openEntryStream(zipFile, entry);
      const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
      await pipeline(input, output);
    });
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}
