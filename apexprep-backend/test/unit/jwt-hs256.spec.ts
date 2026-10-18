import { createHmac } from 'node:crypto';
import { JwtError, signHs256, verifyHs256, type JwtClaims } from '../../src/auth/jwt-hs256';

const SECRET = 'unit-test-secret-that-is-at-least-32-chars';
const OPTS = { issuer: 'apexprep-api', audience: 'apexprep-web', nowSec: 1_000_000 };
const claims = (over: Partial<JwtClaims> = {}): JwtClaims => ({
  sub: '6f1c2c1e-0000-4000-8000-000000000001',
  iss: 'apexprep-api',
  aud: 'apexprep-web',
  iat: 1_000_000,
  exp: 1_000_900,
  jti: 'j1',
  ...over,
});
const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof JwtError ? e.reason : `unexpected ${String(e)}`;
  }
  return 'accepted';
};

describe('HS256 JWT', () => {
  it('round-trips claims', () => {
    const token = signHs256(claims({ tid: 't1' }), SECRET);
    expect(verifyHs256(token, SECRET, OPTS)).toMatchObject({ sub: claims().sub, tid: 't1' });
  });

  it('rejects a token signed with another secret', () => {
    expect(reason(() => verifyHs256(signHs256(claims(), 'another-secret-another-secret-xx'), SECRET, OPTS))).toBe('bad_signature');
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signHs256(claims(), SECRET).split('.');
    expect(reason(() => verifyHs256(`${h}.${b64(claims({ sub: 'someone-else' }))}.${s}`, SECRET, OPTS))).toBe('bad_signature');
  });

  it('rejects alg:none and algorithm substitution, even when correctly "signed"', () => {
    for (const header of [{ alg: 'none', typ: 'JWT' }, { alg: 'HS512', typ: 'JWT' }, { alg: 'RS256', typ: 'JWT' }, { alg: 'HS256', typ: 'JWT', kid: 'x' }]) {
      const input = `${b64(header)}.${b64(claims())}`;
      const sig = createHmac('sha256', SECRET).update(input).digest('base64url');
      expect(reason(() => verifyHs256(`${input}.${sig}`, SECRET, OPTS))).toBe('bad_header');
    }
    expect(reason(() => verifyHs256(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.`, SECRET, OPTS))).toBe('malformed');
  });

  it('rejects a non-canonical signature encoding', () => {
    const token = signHs256(claims(), SECRET);
    expect(reason(() => verifyHs256(`${token}A`, SECRET, OPTS))).toBe('bad_signature');
  });

  it('enforces exp, nbf, iat, iss and aud', () => {
    expect(reason(() => verifyHs256(signHs256(claims({ exp: 1_000_000 }), SECRET), SECRET, OPTS))).toBe('expired');
    expect(reason(() => verifyHs256(signHs256(claims({ nbf: 1_000_100 }), SECRET), SECRET, OPTS))).toBe('not_yet_valid');
    expect(reason(() => verifyHs256(signHs256(claims({ iat: 1_000_500 }), SECRET), SECRET, OPTS))).toBe('bad_claims');
    expect(reason(() => verifyHs256(signHs256(claims({ iss: 'someone-else' }), SECRET), SECRET, OPTS))).toBe('bad_issuer');
    expect(reason(() => verifyHs256(signHs256(claims({ aud: 'another-app' }), SECRET), SECRET, OPTS))).toBe('bad_audience');
  });

  it('honours clock tolerance', () => {
    const token = signHs256(claims({ exp: 999_998 }), SECRET);
    expect(reason(() => verifyHs256(token, SECRET, { ...OPTS, clockToleranceSec: 5 }))).toBe('accepted');
  });

  it('rejects malformed input without throwing anything else', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'x'.repeat(5000), '###.###.###', `${b64('not json')}.${b64(claims())}.sig`]) {
      expect(['malformed', 'bad_header']).toContain(reason(() => verifyHs256(bad, SECRET, OPTS)));
    }
  });
});
