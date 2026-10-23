import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;

function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

/** Node-only password hashing; callers retain their own key formats and authorization policies. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveKey(secret, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifySecret(
  secret: string,
  keyHash: string,
  options: { allowTrailingFields?: boolean } = {},
): Promise<boolean> {
  const parts = keyHash.split("$");
  if (parts.length < 6 || (!options.allowTrailingFields && parts.length !== 6)) return false;
  const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedHash] = parts;
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION ||
    !encodedSalt ||
    !encodedHash
  )
    return false;
  try {
    const expected = Buffer.from(encodedHash, "base64url");
    if (expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await deriveKey(secret, Buffer.from(encodedSalt, "base64url"));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function parseBearerToken(authorization: string | null | undefined): string | null {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

export function normalizeOptionalToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token ? token : null;
}

export function tokensEqual(expected: string, actual: string): boolean {
  // Digest first so variable-length UTF-8 tokens can be compared in constant time.
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}
