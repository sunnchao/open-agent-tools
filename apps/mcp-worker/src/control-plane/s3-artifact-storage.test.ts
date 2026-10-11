import assert from "node:assert/strict";
import test from "node:test";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  createS3ArtifactStorage,
  S3ArtifactStorage,
  type PresignFunction,
  type S3CommandClient,
} from "./s3-artifact-storage.js";

test("ZIP-001 signs a PUT with exact size, content type, and SHA-256 checksum", async () => {
  const sent: unknown[] = [];
  const client: S3CommandClient = {
    send: async (command) => {
      sent.push(command);
      return {};
    },
  };
  const presign: PresignFunction = async (_client, command, options) => {
    assert.ok(command instanceof PutObjectCommand);
    assert.deepEqual(command.input, {
      Bucket: "mcp-artifacts",
      Key: "service/version/artifact.zip",
      Body: undefined,
      ContentType: "application/zip",
      ContentLength: 1024,
      ChecksumSHA256: Buffer.alloc(32, 0xaa).toString("base64"),
      Metadata: { sha256: `sha256:${"aa".repeat(32)}` },
    });
    assert.deepEqual(options, { expiresIn: 900 });
    return "https://objects.example/signed";
  };
  const storage = new S3ArtifactStorage(client, "mcp-artifacts", {
    presign,
    now: () => "2026-07-31T12:00:00.000Z",
  });

  const upload = await storage.createUpload({
    objectKey: "service/version/artifact.zip",
    contentType: "application/zip",
    contentLength: 1024,
    checksumSha256Base64: Buffer.alloc(32, 0xaa).toString("base64"),
    expiresAt: "2026-07-31T12:15:00.000Z",
  });

  assert.equal(sent.length, 0);
  assert.deepEqual(upload, {
    url: "https://objects.example/signed",
    method: "PUT",
    headers: {
      "content-type": "application/zip",
      "content-length": "1024",
      "x-amz-checksum-sha256": Buffer.alloc(32, 0xaa).toString("base64"),
      "x-amz-meta-sha256": `sha256:${"aa".repeat(32)}`,
    },
    expiresAt: "2026-07-31T12:15:00.000Z",
  });
});

test("ZIP-001 keeps integrity values in signed headers for R2-compatible PUTs", async () => {
  const { storage, close } = createS3ArtifactStorage("mcp-artifacts", {
    region: "auto",
    endpoint: "https://account.r2.cloudflarestorage.com",
    forcePathStyle: true,
    credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
  });

  try {
    const upload = await storage.createUpload({
      objectKey: "service/version/artifact.zip",
      contentType: "application/zip",
      contentLength: 1024,
      checksumSha256Base64: Buffer.alloc(32, 0xaa).toString("base64"),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    const url = new URL(upload.url);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];

    assert.equal(url.searchParams.has("x-amz-checksum-sha256"), false);
    assert.equal(url.searchParams.has("x-amz-meta-sha256"), false);
    assert.ok(signedHeaders.includes("x-amz-checksum-sha256"));
    assert.ok(signedHeaders.includes("x-amz-meta-sha256"));
  } finally {
    close();
  }
});

test("ZIP-001 reads object size and checksum through HEAD", async () => {
  const client: S3CommandClient = {
    send: async (command) => {
      assert.ok(command instanceof HeadObjectCommand);
      assert.deepEqual(command.input, {
        Bucket: "mcp-artifacts",
        Key: "service/version/artifact.zip",
        ChecksumMode: "ENABLED",
      });
      return {
        ContentLength: 1024,
        ChecksumSHA256: Buffer.alloc(32, 0xbb).toString("base64"),
      };
    },
  };
  const storage = new S3ArtifactStorage(client, "mcp-artifacts");

  assert.deepEqual(await storage.headObject("service/version/artifact.zip"), {
    size: 1024,
    sha256: `sha256:${"bb".repeat(32)}`,
  });
});

test("ZIP-002 maps a missing S3 object to null", async () => {
  const client: S3CommandClient = {
    send: async () => {
      throw Object.assign(new Error("missing"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
    },
  };
  const storage = new S3ArtifactStorage(client, "mcp-artifacts");

  assert.equal(await storage.headObject("missing.zip"), null);
});
