import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ZipFile } from "yazl";

import {
  ArchiveValidationError,
  extractZipArchive,
  inspectZipArchive,
  type ArchiveLimits,
} from "./archive.js";

interface ZipEntryFixture {
  name: string;
  content?: string | Buffer;
  mode?: number;
}

const generousLimits: ArchiveLimits = {
  maxCompressedBytes: 1024 * 1024,
  maxExpandedBytes: 1024 * 1024,
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
};

async function createZip(directory: string, entries: ZipEntryFixture[]): Promise<string> {
  const archivePath = join(directory, "fixture.zip");
  const zip = new ZipFile();

  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content ?? "fixture"), entry.name, {
      mode: entry.mode,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const output = zip.outputStream.pipe(createWriteStream(archivePath));
    output.on("close", resolve);
    output.on("error", reject);
    zip.end();
  });

  return archivePath;
}

async function replaceEntryName(
  archivePath: string,
  originalName: string,
  replacementName: string,
): Promise<void> {
  assert.equal(Buffer.byteLength(originalName), Buffer.byteLength(replacementName));
  const bytes = await readFile(archivePath);
  const original = Buffer.from(originalName);
  const replacement = Buffer.from(replacementName);
  let replacements = 0;

  for (let offset = 0; offset <= bytes.length - original.length; offset += 1) {
    if (bytes.subarray(offset, offset + original.length).equals(original)) {
      replacement.copy(bytes, offset);
      replacements += 1;
      offset += original.length - 1;
    }
  }

  assert.equal(replacements, 2, "expected local and central directory names");
  await writeFile(archivePath, bytes);
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-worker-archive-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertArchiveError(
  action: () => Promise<unknown>,
  code: ArchiveValidationError["code"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ArchiveValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("ZIP-003 rejects traversal and absolute entry paths before extraction", async () => {
  await withTempDirectory(async (directory) => {
    for (const [safeName, unsafeName] of [
      ["aa/evil.txt", "../evil.txt"],
      ["safe/file.txt", "/abs/file.txt"],
      ["aa/evil.txt", "C:/evil.txt"],
    ]) {
      const archivePath = await createZip(directory, [{ name: safeName }]);
      await replaceEntryName(archivePath, safeName, unsafeName);
      await assertArchiveError(() => inspectZipArchive(archivePath, generousLimits), "UNSAFE_PATH");
    }
  });
});

test("ZIP-003 rejects symbolic links and special Unix files", async () => {
  await withTempDirectory(async (directory) => {
    for (const mode of [0o120777, 0o060600, 0o020600, 0o010600, 0o140600]) {
      const archivePath = await createZip(directory, [
        { name: "special", content: "target", mode },
      ]);
      await assertArchiveError(
        () => inspectZipArchive(archivePath, generousLimits),
        "UNSUPPORTED_ENTRY_TYPE",
      );
    }
  });
});

test("ZIP-003 rejects duplicate normalized file paths", async () => {
  await withTempDirectory(async (directory) => {
    const archivePath = await createZip(directory, [{ name: "first.txt" }, { name: "other.txt" }]);
    await replaceEntryName(archivePath, "other.txt", "first.txt");
    await assertArchiveError(
      () => inspectZipArchive(archivePath, generousLimits),
      "DUPLICATE_PATH",
    );
  });
});

test("ZIP-003 rejects a regular file used as another entry's parent", async () => {
  await withTempDirectory(async (directory) => {
    const archivePath = await createZip(directory, [
      { name: "parent", content: "not a directory" },
      { name: "parent/child.txt", content: "nested" },
    ]);
    await assertArchiveError(() => inspectZipArchive(archivePath, generousLimits), "PATH_CONFLICT");
  });
});

test("ZIP-004 rejects compressed archive size over the configured limit", async () => {
  await withTempDirectory(async (directory) => {
    const archivePath = await createZip(directory, [{ name: "file.txt" }]);
    const archiveSize = (await stat(archivePath)).size;
    await assertArchiveError(
      () =>
        inspectZipArchive(archivePath, {
          ...generousLimits,
          maxCompressedBytes: archiveSize - 1,
        }),
      "COMPRESSED_SIZE_LIMIT",
    );
  });
});

test("ZIP-004 rejects expanded, individual file, and file count limits", async () => {
  await withTempDirectory(async (directory) => {
    const archivePath = await createZip(directory, [
      { name: "one.txt", content: "12345" },
      { name: "two.txt", content: "67890" },
    ]);

    await assertArchiveError(
      () => inspectZipArchive(archivePath, { ...generousLimits, maxExpandedBytes: 9 }),
      "EXPANDED_SIZE_LIMIT",
    );
    await assertArchiveError(
      () => inspectZipArchive(archivePath, { ...generousLimits, maxFileBytes: 4 }),
      "FILE_SIZE_LIMIT",
    );
    await assertArchiveError(
      () => inspectZipArchive(archivePath, { ...generousLimits, maxFiles: 1 }),
      "FILE_COUNT_LIMIT",
    );
  });
});

test("ZIP-003 safely extracts regular files and directories", async () => {
  await withTempDirectory(async (directory) => {
    const archivePath = await createZip(directory, [
      { name: "mcp.json", content: "{}" },
      { name: "src/index.js", content: "export const handlers = {};" },
    ]);
    const destination = join(directory, "output");

    const inspection = await inspectZipArchive(archivePath, generousLimits);
    await extractZipArchive(archivePath, destination, inspection);

    assert.equal(await readFile(join(destination, "mcp.json"), "utf8"), "{}");
    assert.equal(
      await readFile(join(destination, "src/index.js"), "utf8"),
      "export const handlers = {};",
    );
  });
});
