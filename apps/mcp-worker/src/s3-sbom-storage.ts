import { createReadStream } from "node:fs";

import { PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
}

export class S3SbomStorage {
  readonly #client: S3CommandClient;
  readonly #bucket: string;

  constructor(client: S3CommandClient, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async upload(objectKey: string, path: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: createReadStream(path),
        ContentType: "application/vnd.cyclonedx+json",
      }),
    );
  }
}

export function createS3SbomStorage(
  bucket: string,
  config: S3ClientConfig,
): { storage: S3SbomStorage; close: () => void } {
  const client = new S3Client(config);
  return { storage: new S3SbomStorage(client, bucket), close: () => client.destroy() };
}
