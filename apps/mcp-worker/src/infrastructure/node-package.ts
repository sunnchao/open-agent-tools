import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ManagedMcpManifestSchema, type ManagedMcpManifest } from "@open-agent-tools/mcp-contracts";

export type NodePackageValidationCode =
  | "COMMONJS_NOT_SUPPORTED"
  | "INVALID_JSON"
  | "INVALID_LOCKFILE"
  | "INVALID_MANIFEST"
  | "INVALID_PACKAGE_JSON"
  | "MISSING_BUILD_SCRIPT"
  | "MISSING_ENTRY"
  | "MISSING_REQUIRED_FILE"
  | "PACKAGE_LOCK_MISMATCH"
  | "TOOLS_REQUIRED";

export class NodePackageValidationError extends Error {
  constructor(
    public readonly code: NodePackageValidationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodePackageValidationError";
  }
}

interface JsonObject {
  [key: string]: unknown;
}

export interface ValidatedNodeToolPackage {
  manifest: ManagedMcpManifest;
  packageJson: JsonObject & { type: "module" };
  packageLock: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequiredJson(root: string, name: string): Promise<unknown> {
  const path = resolve(root, name);
  let contents: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new NodePackageValidationError(
        "MISSING_REQUIRED_FILE",
        `${name} must be a regular file at the package root`,
      );
    }
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof NodePackageValidationError) throw cause;
    throw new NodePackageValidationError(
      "MISSING_REQUIRED_FILE",
      `${name} is required at the package root`,
      { cause },
    );
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new NodePackageValidationError("INVALID_JSON", `${name} must contain valid JSON`, {
      cause,
    });
  }
}

function validatePackageLock(packageJson: JsonObject, packageLock: unknown): JsonObject {
  if (!isJsonObject(packageLock)) {
    throw new NodePackageValidationError(
      "INVALID_LOCKFILE",
      "package-lock.json must contain a JSON object",
    );
  }

  const rootPackage = isJsonObject(packageLock.packages) ? packageLock.packages[""] : undefined;
  if (![2, 3].includes(packageLock.lockfileVersion as number) || !isJsonObject(rootPackage)) {
    throw new NodePackageValidationError(
      "INVALID_LOCKFILE",
      "package-lock.json must be npm lockfile version 2 or 3",
    );
  }

  for (const field of ["name", "version"] as const) {
    if (
      packageJson[field] !== undefined &&
      rootPackage[field] !== undefined &&
      packageJson[field] !== rootPackage[field]
    ) {
      throw new NodePackageValidationError(
        "PACKAGE_LOCK_MISMATCH",
        `package-lock.json root ${field} does not match package.json`,
      );
    }
  }

  return packageLock;
}

async function requirePrebuiltEntry(root: string, manifest: ManagedMcpManifest): Promise<void> {
  if (manifest.build !== undefined || manifest.entry === undefined) return;

  try {
    const entry = await lstat(resolve(root, ...manifest.entry.split("/")));
    if (!entry.isFile()) throw new Error("entry is not a regular file");
  } catch (cause) {
    throw new NodePackageValidationError(
      "MISSING_ENTRY",
      "Manifest entry must exist when no build command is declared",
      { cause },
    );
  }
}

export async function readNodeToolPackage(root: string): Promise<ValidatedNodeToolPackage> {
  const [manifestJson, packageJsonValue, packageLockValue] = await Promise.all([
    readRequiredJson(root, "mcp.json"),
    readRequiredJson(root, "package.json"),
    readRequiredJson(root, "package-lock.json"),
  ]);

  const manifestResult = ManagedMcpManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    throw new NodePackageValidationError("INVALID_MANIFEST", "mcp.json is invalid", {
      cause: manifestResult.error,
    });
  }
  if (manifestResult.data.tools.length === 0) {
    throw new NodePackageValidationError(
      "TOOLS_REQUIRED",
      "Uploaded Node.js packages must define at least one Tool",
    );
  }

  if (!isJsonObject(packageJsonValue)) {
    throw new NodePackageValidationError(
      "INVALID_PACKAGE_JSON",
      "package.json must contain a JSON object",
    );
  }
  if (packageJsonValue.type !== "module") {
    throw new NodePackageValidationError(
      "COMMONJS_NOT_SUPPORTED",
      'package.json must declare "type": "module"',
    );
  }

  if (manifestResult.data.build !== undefined) {
    const scripts = packageJsonValue.scripts;
    if (!isJsonObject(scripts) || typeof scripts.build !== "string" || scripts.build.length === 0) {
      throw new NodePackageValidationError(
        "MISSING_BUILD_SCRIPT",
        "package.json must define scripts.build when mcp.json declares a build",
      );
    }
  }

  const packageLock = validatePackageLock(packageJsonValue, packageLockValue);
  await requirePrebuiltEntry(root, manifestResult.data);

  return {
    manifest: manifestResult.data,
    packageJson: packageJsonValue as JsonObject & { type: "module" },
    packageLock,
  };
}
