import { ConfigService } from '@nestjs/config';
import { AppException } from '../../src/common/errors/app-exception';
import { passwordPolicyViolation, PasswordService } from '../../src/auth/password.service';
import { OPAQUE_TOKEN_PATTERN, TokenService } from '../../src/auth/token.service';
import { signHs256 } from '../../src/auth/jwt-hs256';

const config = new ConfigService({
  JWT_ACCESS_SECRET: 'unit-test-secret-that-is-at-least-32-chars',
  JWT_ISSUER: 'apexprep-api',
  JWT_AUDIENCE: 'apexprep-web',
  JWT_ACCESS_TTL_SECONDS: 900,
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
});
const USER = '6f1c2c1e-0000-4000-8000-000000000001';
const TENANT = '6f1c2c1e-0000-4000-8000-000000000002';

describe('TokenService', () => {
  const tokens = new TokenService(config as never);

  it('issues access tokens carrying user, tenant, role and token version', () => {
    const claims = tokens.verifyAccessToken(tokens.signAccessToken({ userId: USER, tenantId: TENANT, role: 'ADMIN', tokenVersion: 3 }));
    expect(claims).toEqual({ userId: USER, tenantId: TENANT, role: 'ADMIN', tokenVersion: 3 });
  });

  it('rejects a correctly signed token that is not an access token or has bad claims', () => {
    const base = { sub: USER, tid: TENANT, role: 'ADMIN', ver: 0, iss: 'apexprep-api', aud: 'apexprep-web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, jti: 'x' };
    for (const bad of [{ ...base }, { ...base, typ: 'refresh' }, { ...base, typ: 'access', role: 'GOD' }, { ...base, typ: 'access', tid: 'nope' }]) {
      const token = signHs256(bad, 'unit-test-secret-that-is-at-least-32-chars');
      expect(() => tokens.verifyAccessToken(token)).toThrow(AppException);
    }
  });

  it('maps an expired token to TOKEN_EXPIRED', () => {
    const old = tokens.signAccessToken({ userId: USER, tenantId: TENANT, role: 'STUDENT', tokenVersion: 0 }, Math.floor(Date.now() / 1000) - 3600);
    try {
      tokens.verifyAccessToken(old);
      throw new Error('accepted');
    } catch (e) {
      expect((e as AppException).code).toBe('TOKEN_EXPIRED');
    }
  });

  it('makes 256-bit opaque tokens and stores only a 32-byte digest', () => {
    const a = tokens.newOpaqueToken();
    expect(a).toMatch(OPAQUE_TOKEN_PATTERN);
    expect(tokens.newOpaqueToken()).not.toEqual(a);
    expect(tokens.hashOpaqueToken(a)).toHaveLength(32);
    expect(tokens.hashOpaqueToken(a).equals(tokens.hashOpaqueToken(a))).toBe(true);
  });
});

describe('PasswordService', () => {
  const passwords = new PasswordService(config as never);

  it('hashes with argon2id at the configured cost and verifies', async () => {
    const encoded = await passwords.hash('correct-horse-9');
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(passwords.verify(encoded, 'correct-horse-9')).resolves.toBe(true);
    await expect(passwords.verify(encoded, 'Correct-horse-9')).resolves.toBe(false);
    await expect(passwords.verify('not-a-hash', 'x')).resolves.toBe(false);
    expect(passwords.needsRehash(encoded)).toBe(false);
  });

  it('flags hashes made with weaker parameters for upgrade', async () => {
    const weak = await new PasswordService(new ConfigService({ ARGON2_MEMORY_KIB: 4096, ARGON2_TIME_COST: 2 }) as never).hash('x-password');
    expect(passwords.needsRehash(weak)).toBe(true);
  });

  it('applies the password policy', () => {
    expect(passwordPolicyViolation('short')).toMatch(/at least 8/);
    expect(passwordPolicyViolation('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordPolicyViolation('         ')).toMatch(/blank/);
    expect(passwordPolicyViolation('me@example.com', 'ME@example.com')).toMatch(/email/);
    expect(passwordPolicyViolation('correct-horse-9', 'me@example.com')).toBeNull();
  });
});
