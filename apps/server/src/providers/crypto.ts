import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function encryptionKey(): Buffer {
  const value = process.env.PROVIDER_KEYS_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("CONFIG_ERROR: PROVIDER_KEYS_ENCRYPTION_KEY is not set");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("CONFIG_ERROR: PROVIDER_KEYS_ENCRYPTION_KEY must be 64 hex characters");
  }
  return Buffer.from(value, "hex");
}

export function encryptProviderKey(value: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptProviderKey(value: string): string {
  const payload = Buffer.from(value, "base64");
  if (payload.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Invalid encrypted Provider API key");
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function maskProviderKey(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length < 8 ? "***" : `${value.slice(0, 2)}***${value.slice(-3)}`;
}
