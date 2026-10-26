import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { afterEach, describe, it } from "node:test";
import {
  createOidcVerifier,
  enterpriseIdentityStatus,
  readEnterpriseIdentityConfig,
  studioActorFromClaims,
  type EnterpriseIdentityConfig,
} from "./enterprise.js";

const issuer = "https://idp.example.test";
const audience = "open-agent-tools-studio";
let now = Math.floor(Date.now() / 1000);

afterEach(() => {
  now = Math.floor(Date.now() / 1000);
});

async function rsaFixture() {
  const fixture = await generateKeyPair("RS256");
  const jwk = await exportJWK(fixture.publicKey);
  jwk.kid = "rsa-test";
  jwk.alg = "RS256";
  return { ...fixture, jwk, keySet: createLocalJWKSet({ keys: [jwk] }) };
}

function config(): EnterpriseIdentityConfig {
  return {
    oidc: {
      issuer,
      audience,
      jwksUri: "https://idp.example.test/.well-known/jwks.json",
      groupsClaim: "groups",
      rolesClaim: "roles",
      adminRoles: ["studio-admin", "platform-admin"],
      algorithms: ["RS256", "ES256"],
      maxTokenAgeSeconds: null,
      clockToleranceSeconds: 0,
    },
    ldap: null,
  };
}

async function token(
  fixture: Awaited<ReturnType<typeof rsaFixture>>,
  overrides: {
    payload?: Record<string, unknown>;
    issuer?: string;
    audience?: string;
    expiresAt?: number;
  } = {},
): Promise<string> {
  return new SignJWT({
    groups: ["hr"],
    roles: ["studio-admin"],
    ...overrides.payload,
  })
    .setProtectedHeader({ alg: "RS256", kid: "rsa-test" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject("user-1")
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(fixture.privateKey);
}

describe("enterprise OIDC identity", () => {
  it("maps groups and roles from configurable claims", async () => {
    const fixture = await rsaFixture();
    const verifier = createOidcVerifier({ config: config().oidc!, keySet: fixture.keySet });
    const actor = await verifier.verify(await token(fixture));
    assert.deepEqual(actor, {
      source: "oidc",
      subject: "user-1",
      email: null,
      groups: ["hr"],
      roles: ["studio-admin"],
      role: "admin",
    });
    assert.equal(studioActorFromClaims({ sub: "u", groups: "eng" }).groups[0], "eng");
  });

  it("rejects a forged signature", async () => {
    const trusted = await rsaFixture();
    const forged = await rsaFixture();
    const verifier = createOidcVerifier({ config: config().oidc!, keySet: trusted.keySet });
    await assert.rejects(verifier.verify(await token(forged)));
  });

  it("rejects an expired token", async () => {
    const fixture = await rsaFixture();
    const jwt = await token(fixture, { expiresAt: now - 1 });
    const verifier = createOidcVerifier({ config: config().oidc!, keySet: fixture.keySet });
    await assert.rejects(verifier.verify(jwt));
  });

  it("rejects a token without an expiration claim", async () => {
    const fixture = await rsaFixture();
    const jwt = await new SignJWT({ groups: ["hr"], roles: ["studio-admin"] })
      .setProtectedHeader({ alg: "RS256", kid: "rsa-test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-1")
      .setIssuedAt(now)
      .sign(fixture.privateKey);
    const verifier = createOidcVerifier({ config: config().oidc!, keySet: fixture.keySet });
    await assert.rejects(verifier.verify(jwt));
  });

  it("rejects the wrong audience", async () => {
    const fixture = await rsaFixture();
    const verifier = createOidcVerifier({ config: config().oidc!, keySet: fixture.keySet });
    await assert.rejects(verifier.verify(await token(fixture, { audience: "another-app" })));
  });

  it("does not accept unsigned tokens", async () => {
    const fixture = await rsaFixture();
    const unsigned = new UnsecuredJWT({ groups: ["hr"], roles: ["studio-admin"] })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-1")
      .setExpirationTime(now + 300)
      .encode();
    const verifier = createOidcVerifier({ config: config().oidc!, keySet: fixture.keySet });
    await assert.rejects(verifier.verify(unsigned));
  });
});

describe("enterprise identity readiness", () => {
  it("requires OIDC settings as a complete set", () => {
    assert.throws(
      () => readEnterpriseIdentityConfig({ OIDC_ISSUER: issuer }),
      /configured together/,
    );
  });

  it("reports LDAP gateway readiness without exposing secrets", () => {
    const status = enterpriseIdentityStatus(
      {
        oidc: null,
        ldap: {
          trustedGatewayUrl: "https://gateway.example.test/ldap",
          mode: "trusted-gateway",
        },
      },
      true,
      {
        PUBLISHED_APP_ASSERTION_HMAC_SECRET: "must-never-appear",
        PUBLISHED_APP_ASSERTION_KEY_ID: "gateway-2026",
        PUBLISHED_APP_ASSERTION_ISSUER: "corp-gateway",
        PUBLISHED_APP_ASSERTION_AUDIENCE: "open-agent-tools",
        PUBLISHED_APP_IDENTITY_MODE: "required_for_groups",
      },
    );
    assert.equal(status.ldap.readiness, "ready");
    assert.equal(status.ldap.passwordBinding, false);
    assert.equal(status.ldap.assertionKeyId, "gateway-2026");
    assert.equal(JSON.stringify(status).includes("must-never-appear"), false);
  });

  it("degrades an invalid LDAP gateway URL to readiness status instead of blocking auth", () => {
    const config = readEnterpriseIdentityConfig({
      LDAP_TRUSTED_GATEWAY_URL: "not a valid url",
    });
    assert.equal(config.ldap, null);
    assert.ok(config.ldapConfigError);
    const status = enterpriseIdentityStatus(config, true);
    assert.equal(status.ldap.readiness, "invalid_config");
    assert.equal(status.deploymentTokenFallback, true);
  });
});
