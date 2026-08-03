import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

export interface CreatedApiKey {
  keyId: string;
  rawKey: string;
  keyHash: string;
}

function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const parts = rawKey.split(".");
  if (parts.length !== 3 || parts[0] !== "mcp") return null;
  const [, keyId, secret] = parts;
  if (!keyId || !secret || !KEY_ID_PATTERN.test(keyId) || !SECRET_PATTERN.test(secret)) return null;
  return { keyId, secret };
}

export async function createApiKey(
  keyId: string,
  secretSource: () => Buffer = () => randomBytes(32),
): Promise<CreatedApiKey> {
  if (!KEY_ID_PATTERN.test(keyId)) throw new TypeError("keyId must be a lowercase UUID");
  const secretBytes = secretSource();
  if (secretBytes.length !== 32) throw new TypeError("API Key secret must contain 32 bytes");
  const secret = secretBytes.toString("base64url");
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(secret, salt);
  const keyHash = [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
  return { keyId, rawKey: `mcp.${keyId}.${secret}`, keyHash };
}

export async function verifyApiKey(rawKey: string, keyHash: string): Promise<boolean> {
  const parsed = parseApiKey(rawKey);
  if (!parsed) return false;
  const parts = keyHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, cost, blockSize, parallelization, encodedSalt, encodedHash] = parts;
  if (
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION ||
    !encodedSalt ||
    !encodedHash
  ) {
    return false;
  }

  try {
    const expected = Buffer.from(encodedHash, "base64url");
    if (expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await deriveKey(parsed.secret, Buffer.from(encodedSalt, "base64url"));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
