import { GetObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
}

function bodyAsReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof Uint8Array) return Readable.from([body]);
  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw new Error("Object storage response has no readable body");
}

export class S3ArtifactDownload {
  readonly #client: S3CommandClient;
  readonly #bucket: string;

  constructor(client: S3CommandClient, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async download(objectKey: string): Promise<Readable> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    if (typeof response !== "object" || response === null || !("Body" in response)) {
      throw new Error("Object storage response has no body");
    }
    return bodyAsReadable((response as { Body?: unknown }).Body);
  }
}

export function createS3ArtifactDownload(
  bucket: string,
  config: S3ClientConfig,
): { storage: S3ArtifactDownload; close: () => void } {
  const client = new S3Client(config);
  return { storage: new S3ArtifactDownload(client, bucket), close: () => client.destroy() };
}
