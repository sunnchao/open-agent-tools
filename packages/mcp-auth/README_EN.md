# MCP Auth

[中文](./README.md) | [Platform overview](../../README_EN.md)

`@open-agent-tools/mcp-auth` generates, parses, and verifies MCP Client API Keys. The Control Plane uses it to issue Keys, and the MCP Gateway uses it to verify Bearer Tokens without storing the raw secret in PostgreSQL.

## Key format

```text
mcp.<key-id>.<secret>
```

- `key-id` must be a lowercase UUID, for example `4d36e967-e325-11ce-bfc1-08002be10318`.
- `secret` is 32 random bytes encoded as a 43-character Base64URL string.
- For malformed values, `parseApiKey` returns `null` and `verifyApiKey` returns `false`.

## Public API

| API                                  | Description                                                      |
| ------------------------------------ | ---------------------------------------------------------------- |
| `createApiKey(keyId, secretSource?)` | Generates a raw Key and a persistable scrypt hash                |
| `parseApiKey(rawKey)`                | Validates the Key structure and returns its `keyId` and `secret` |
| `verifyApiKey(rawKey, keyHash)`      | Derives the key again and compares the secret in constant time   |

`createApiKey` returns:

```ts
interface CreatedApiKey {
  keyId: string;
  rawKey: string;
  keyHash: string;
}
```

`secretSource` exists primarily for deterministic tests. Production code should use the default `randomBytes(32)` implementation.

## Example

```ts
import { createApiKey, parseApiKey, verifyApiKey } from "@open-agent-tools/mcp-auth";

const created = await createApiKey("4d36e967-e325-11ce-bfc1-08002be10318");

// Persist only created.keyHash. Show created.rawKey once in the creation response.
const parsed = parseApiKey(created.rawKey);
const valid = await verifyApiKey(created.rawKey, created.keyHash);
```

## Hash format

The persisted `keyHash` uses this self-describing format:

```text
scrypt$16384$8$1$<salt-base64url>$<derived-key-base64url>
```

Fixed parameters:

| Parameter           | Value           |
| ------------------- | --------------- |
| Cost `N`            | `16384`         |
| Block size `r`      | `8`             |
| Parallelization `p` | `1`             |
| Salt                | 16 random bytes |
| Derived key         | 32 bytes        |
| `maxmem`            | 64 MiB          |

Verification rejects hashes with an unexpected algorithm marker or parameter set, a missing salt, or an invalid derived-key length. Secret comparison uses Node.js `timingSafeEqual`.

## Security constraints

- A raw API Key is a Bearer Credential and must be shown to the administrator only once at creation time.
- Persist only the `keyId`, `keyHash`, status, expiry, and owning Client. Never persist the raw Key or secret.
- Logs, audit events, and error responses must not contain the raw Key.
- Key revocation, expiry, Client status, and Grant checks belong to the Gateway authorization flow. This package handles only cryptographic Key verification.
- `parseApiKey` validates structure only; it does not prove that a Key is registered or active.

## Development commands

```bash
pnpm --filter @open-agent-tools/mcp-auth build
pnpm --filter @open-agent-tools/mcp-auth typecheck
pnpm --filter @open-agent-tools/mcp-auth lint
pnpm --filter @open-agent-tools/mcp-auth test
```
