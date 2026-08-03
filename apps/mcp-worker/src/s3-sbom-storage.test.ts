import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { S3SbomStorage, type S3CommandClient } from "./s3-sbom-storage.js";

class FakeS3Client implements S3CommandClient {
  command: unknown;

  async send(command: unknown): Promise<unknown> {
    this.command = command;
    return {};
  }
}

test("BLD-001 uploads the generated CycloneDX SBOM to object storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-sbom-"));
  try {
    const path = join(directory, "sbom.json");
    await writeFile(path, '{"bomFormat":"CycloneDX"}');
    const client = new FakeS3Client();
    await new S3SbomStorage(client, "mcp-artifacts").upload("sbom/build-1.json", path);

    const command = client.command as PutObjectCommand;
    assert.equal(command.input.Bucket, "mcp-artifacts");
    assert.equal(command.input.Key, "sbom/build-1.json");
    assert.equal(command.input.ContentType, "application/vnd.cyclonedx+json");
    assert.equal(
      Buffer.concat(await (command.input.Body as NodeJS.ReadableStream & { toArray(): Promise<Buffer[]> }).toArray()).toString(),
      '{"bomFormat":"CycloneDX"}',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
