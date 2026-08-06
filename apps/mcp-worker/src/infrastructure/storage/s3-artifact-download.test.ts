import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { S3ArtifactDownload, type S3CommandClient } from "./s3-artifact-download.js";

class FakeS3Client implements S3CommandClient {
  command: unknown;
  constructor(readonly response: unknown) {}

  async send(command: unknown): Promise<unknown> {
    this.command = command;
    return this.response;
  }
}

test("ZIP-001 downloads an artifact body from the configured object key", async () => {
  const client = new FakeS3Client({ Body: Readable.from([Buffer.from("artifact")]) });
  const storage = new S3ArtifactDownload(client, "mcp-artifacts");
  const body = await storage.download("service/version/artifact.zip");

  assert.ok(body instanceof Readable);
  assert.equal((client.command as GetObjectCommand).input.Bucket, "mcp-artifacts");
  assert.equal((client.command as GetObjectCommand).input.Key, "service/version/artifact.zip");
  assert.equal(Buffer.concat(await body.toArray()).toString(), "artifact");
});

test("ZIP-002 fails closed when object storage returns no body", async () => {
  const storage = new S3ArtifactDownload(new FakeS3Client({ Body: undefined }), "mcp-artifacts");
  await assert.rejects(storage.download("missing.zip"), /body/i);
});
