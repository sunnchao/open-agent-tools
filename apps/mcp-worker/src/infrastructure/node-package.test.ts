import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodePackageValidationError, readNodeToolPackage } from "./node-package.js";

const manifest = {
  schemaVersion: 1,
  runtime: { name: "nodejs", version: "20" },
  entry: "src/index.js",
  tools: [
    {
      name: "get_report",
      handler: "getReport",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ],
  prompts: [],
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

const packageJson = {
  name: "example-mcp-tools",
  version: "1.0.0",
  type: "module",
  scripts: {
    build: "node build.js",
  },
};

const packageLock = {
  name: "example-mcp-tools",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "example-mcp-tools",
      version: "1.0.0",
    },
  },
};

async function createPackage(
  overrides: Partial<Record<"mcp.json" | "package.json" | "package-lock.json", unknown>> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-worker-package-"));
  await mkdir(join(directory, "src"));

  const files = {
    "mcp.json": manifest,
    "package.json": packageJson,
    "package-lock.json": packageLock,
    ...overrides,
  };

  for (const [name, content] of Object.entries(files)) {
    if (content !== undefined) {
      await writeFile(
        join(directory, name),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
  }
  await writeFile(join(directory, "src/index.js"), "export const handlers = {};\n");
  return directory;
}

async function assertPackageError(
  directory: string,
  code: NodePackageValidationError["code"],
): Promise<void> {
  try {
    await assert.rejects(
      () => readNodeToolPackage(directory),
      (error: unknown) => {
        assert.ok(error instanceof NodePackageValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ZIP-005 accepts a complete Node.js 20 ESM Tool package", async () => {
  const directory = await createPackage();
  try {
    const result = await readNodeToolPackage(directory);
    assert.equal(result.manifest.runtime?.name, "nodejs");
    assert.equal(result.manifest.runtime?.version, "20");
    assert.equal(result.packageJson.type, "module");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ZIP-005 rejects packages missing required root files", async () => {
  for (const requiredFile of ["mcp.json", "package.json", "package-lock.json"] as const) {
    await assertPackageError(
      await createPackage({ [requiredFile]: undefined }),
      "MISSING_REQUIRED_FILE",
    );
  }
});

test("ZIP-006 rejects malformed package JSON", async () => {
  await assertPackageError(await createPackage({ "package.json": "{" }), "INVALID_JSON");
  await assertPackageError(await createPackage({ "package-lock.json": "[]" }), "INVALID_LOCKFILE");
});

test("ZIP-006 rejects package and lockfile metadata mismatch", async () => {
  await assertPackageError(
    await createPackage({
      "package-lock.json": {
        ...packageLock,
        packages: {
          "": { name: "different-package", version: "1.0.0" },
        },
      },
    }),
    "PACKAGE_LOCK_MISMATCH",
  );
});

test("BLD-001 rejects CommonJS packages", async () => {
  await assertPackageError(
    await createPackage({ "package.json": { ...packageJson, type: "commonjs" } }),
    "COMMONJS_NOT_SUPPORTED",
  );
});

test("MAN-005, MAN-006, MAN-010, and MAN-014 reject incompatible manifests", async () => {
  const invalidManifests = [
    { ...manifest, runtime: { name: "python", version: "3.12" } },
    { ...manifest, runtime: { name: "nodejs", version: "22" } },
    { ...manifest, entry: "../index.js" },
    { ...manifest, build: { command: "npm install" } },
  ];

  for (const invalidManifest of invalidManifests) {
    await assertPackageError(
      await createPackage({ "mcp.json": invalidManifest }),
      "INVALID_MANIFEST",
    );
  }
});

test("ZIP-005 rejects an archive manifest without Tools", async () => {
  const promptOnlyManifest = {
    schemaVersion: 1,
    tools: [],
    prompts: [
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
    ],
  };

  await assertPackageError(
    await createPackage({ "mcp.json": promptOnlyManifest }),
    "TOOLS_REQUIRED",
  );
});

test("BLD-001 requires a prebuilt entry when no build command is declared", async () => {
  const directory = await createPackage({
    "mcp.json": { ...manifest, entry: "dist/index.js" },
  });
  await assertPackageError(directory, "MISSING_ENTRY");
});

test("BLD-001 permits a build output entry that does not exist before build", async () => {
  const directory = await createPackage({
    "mcp.json": {
      ...manifest,
      entry: "dist/index.js",
      build: { command: "npm run build" },
    },
  });
  try {
    const result = await readNodeToolPackage(directory);
    assert.equal(result.manifest.build?.command, "npm run build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("BLD-001 requires package.json scripts.build for a build manifest", async () => {
  await assertPackageError(
    await createPackage({
      "mcp.json": {
        ...manifest,
        entry: "dist/index.js",
        build: { command: "npm run build" },
      },
      "package.json": { ...packageJson, scripts: {} },
    }),
    "MISSING_BUILD_SCRIPT",
  );
});
