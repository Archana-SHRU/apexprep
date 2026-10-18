import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal JWT (RFC 7519) with exactly one algorithm: HS256.
 *
 * Deliberately not a general JWT library: the header must be exactly
 * {"alg":"HS256","typ":"JWT"}, so "alg: none" and algorithm-substitution attacks
 * cannot apply. The signature is verified (constant-time, canonical encoding only)
 * before the payload is parsed or trusted. Built on node:crypto HMAC-SHA256 because the
 * build environment could not install a JWT package; TokenService is the only caller,
 * so swapping in `jose` later is a one-file change.
 */

export type JwtFailure =
  | 'malformed'
  | 'bad_header'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_issuer'
  | 'bad_audience'
  | 'bad_claims';

export class JwtError extends Error {
  constructor(readonly reason: JwtFailure) {
    super(`JWT rejected: ${reason}`);
    this.name = 'JwtError';
  }
}

export interface JwtClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  nbf?: number;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  /** Seconds since epoch; injectable for tests. */
  nowSec?: number;
  clockToleranceSec?: number;
}

const ENCODED_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4096;

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function parseJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed');
  }
}

export function signHs256(claims: JwtClaims, secret: string): string {
  const input = `${ENCODED_HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${sign(input, secret)}`;
}

export function verifyHs256(token: string, secret: string, opts: VerifyOptions): JwtClaims {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new JwtError('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) throw new JwtError('malformed');
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  const header = parseJsonSegment(headerSeg) as Record<string, unknown> | null;
  if (
    !header ||
    typeof header !== 'object' ||
    header.alg !== 'HS256' ||
    header.typ !== 'JWT' ||
    Object.keys(header).length !== 2
  ) {
    throw new JwtError('bad_header');
  }

  // Compare against the canonical encoding of the expected MAC, in constant time.
  const expected = Buffer.from(sign(`${headerSeg}.${payloadSeg}`, secret));
  const actual = Buffer.from(signatureSeg);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('bad_signature');
  }

  const claims = parseJsonSegment(payloadSeg) as Partial<JwtClaims> | null;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new JwtError('malformed');

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.clockToleranceSec ?? 0;
  if (
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.sub !== 'string' ||
    typeof claims.jti !== 'string'
  ) {
    throw new JwtError('bad_claims');
  }
  if (now >= claims.exp + tolerance) throw new JwtError('expired');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + tolerance < claims.nbf)) {
    throw new JwtError('not_yet_valid');
  }
  if (claims.iat > now + 60 + tolerance) throw new JwtError('bad_claims');
  if (claims.iss !== opts.issuer) throw new JwtError('bad_issuer');
  if (claims.aud !== opts.audience) throw new JwtError('bad_audience');
  return claims as JwtClaims;
}
