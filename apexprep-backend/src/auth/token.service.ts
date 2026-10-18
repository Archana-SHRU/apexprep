import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../common/errors/app-exception';
import { isRole, type Role } from '../common/auth/permissions';
import type { Env } from '../config/env.schema';
import { JwtError, signHs256, verifyHs256 } from './jwt-hs256';

export interface AccessTokenSubject {
  userId: string;
  tenantId: string;
  role: Role;
  tokenVersion: number;
}

export interface AccessClaims {
  userId: string;
  tenantId: string;
  role: Role;
  tokenVersion: number;
}

/** 32 random bytes, base64url, no padding. Refresh and email-verification tokens. */
export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly issuer: string;
  private readonly audience: string;
  readonly accessTtlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.issuer = config.get('JWT_ISSUER', { infer: true });
    this.audience = config.get('JWT_AUDIENCE', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  signAccessToken(s: AccessTokenSubject, nowSec = Math.floor(Date.now() / 1000)): string {
    return signHs256(
      {
        sub: s.userId,
        tid: s.tenantId,
        role: s.role,
        ver: s.tokenVersion,
        typ: 'access',
        iss: this.issuer,
        aud: this.audience,
        iat: nowSec,
        exp: nowSec + this.accessTtlSeconds,
        jti: randomUUID(),
      },
      this.secret,
    );
  }

  /** Verifies signature, expiry, issuer, audience and claim shape. Throws 401 AppExceptions. */
  verifyAccessToken(token: string): AccessClaims {
    let claims;
    try {
      claims = verifyHs256(token, this.secret, { issuer: this.issuer, audience: this.audience, clockToleranceSec: 5 });
    } catch (err) {
      if (err instanceof JwtError && err.reason === 'expired') {
        throw AppException.unauthenticated('Access token has expired', 'TOKEN_EXPIRED');
      }
      throw AppException.unauthenticated('Access token is invalid', 'TOKEN_INVALID');
    }
    const { sub, tid, role, ver, typ } = claims;
    if (
      typ !== 'access' ||
      !UUID.test(sub) ||
      typeof tid !== 'string' ||
      !UUID.test(tid) ||
      !isRole(role) ||
      typeof ver !== 'number' ||
      !Number.isInteger(ver)
    ) {
      throw AppException.unauthenticated('Access token is invalid', 'TOKEN_INVALID');
    }
    return { userId: sub, tenantId: tid, role, tokenVersion: ver };
  }

  newOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Only this digest is stored; the raw token exists only on the client. */
  hashOpaqueToken(token: string): Buffer {
    return createHash('sha256').update(token, 'utf8').digest();
  }
}
