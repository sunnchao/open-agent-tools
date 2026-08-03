import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type {
  ArtifactObjectMetadata,
  ArtifactStorage,
  CreateArtifactUpload,
  PresignedArtifactUpload,
} from "./artifact-upload.js";

export interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
}

export type PresignFunction = (
  client: S3CommandClient,
  command: PutObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface S3ArtifactStorageOptions {
  now?: () => string;
  presign?: PresignFunction;
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}

const defaultPresign: PresignFunction = (client, command, options) =>
  getSignedUrl(client as S3Client, command, {
    ...options,
    unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-sha256"]),
  });

export class S3ArtifactStorage implements ArtifactStorage {
  readonly #client: S3CommandClient;
  readonly #bucket: string;
  readonly #now: () => string;
  readonly #presign: PresignFunction;

  constructor(client: S3CommandClient, bucket: string, options: S3ArtifactStorageOptions = {}) {
    this.#client = client;
    this.#bucket = bucket;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#presign = options.presign ?? defaultPresign;
  }

  async createUpload(input: CreateArtifactUpload): Promise<PresignedArtifactUpload> {
    const sha256 = `sha256:${Buffer.from(input.checksumSha256Base64, "base64").toString("hex")}`;
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: input.objectKey,
      Body: undefined,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ChecksumSHA256: input.checksumSha256Base64,
      Metadata: { sha256 },
    });
    const expiresIn = Math.max(
      1,
      Math.ceil((Date.parse(input.expiresAt) - Date.parse(this.#now())) / 1000),
    );
    const url = await this.#presign(this.#client, command, { expiresIn });
    return {
      url,
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "content-length": String(input.contentLength),
        "x-amz-checksum-sha256": input.checksumSha256Base64,
        "x-amz-meta-sha256": sha256,
      },
      expiresAt: input.expiresAt,
    };
  }

  async headObject(objectKey: string): Promise<ArtifactObjectMetadata | null> {
    let response: unknown;
    try {
      response = await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ChecksumMode: "ENABLED",
        }),
      );
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }

    if (typeof response !== "object" || response === null) return null;
    const result = response as {
      ContentLength?: unknown;
      ChecksumSHA256?: unknown;
      Metadata?: Record<string, string>;
    };
    const size = result.ContentLength;
    const sha256 =
      typeof result.ChecksumSHA256 === "string"
        ? `sha256:${Buffer.from(result.ChecksumSHA256, "base64").toString("hex")}`
        : result.Metadata?.sha256;
    if (!Number.isSafeInteger(size) || typeof sha256 !== "string") return null;
    return { size: size as number, sha256 };
  }
}

export function createS3ArtifactStorage(
  bucket: string,
  config: S3ClientConfig,
): { storage: S3ArtifactStorage; close: () => void } {
  const client = new S3Client(config);
  return {
    storage: new S3ArtifactStorage(client, bucket),
    close: () => client.destroy(),
  };
}
