import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/request-context/request-context';
import type { Env } from '../config/env.schema';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { refreshTokens, type RefreshTokenRow } from '../database/schema';
import { TokenService } from './token.service';

type RevokeReason = NonNullable<RefreshTokenRow['revokedReason']>;

export type RotationResult =
  | { kind: 'rotated'; userId: string; tenantId: string; familyId: string; token: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'reused' };

/**
 * Opaque refresh tokens with rotation and theft detection.
 *
 * Each token belongs to a family (one login on one device). Refreshing revokes the
 * presented token ('rotated') and issues its successor in the same family. If a token
 * that was already rotated is presented again, someone replayed it: the whole family is
 * revoked ('reuse_detected'), which logs out both the attacker and the victim's device.
 */
@Injectable()
export class RefreshTokensService {
  private readonly ttlMs: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000;
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  /** Start a new family (login/registration) or continue one (rotation). Returns the raw token. */
  async issue(
    tx: Executor,
    owner: { tenantId: string; userId: string; familyId?: string },
  ): Promise<{ token: string; id: string }> {
    const token = this.tokens.newOpaqueToken();
    const ctx = RequestContext.get();
    const [row] = await tx
      .insert(refreshTokens)
      .values({
        tenantId: owner.tenantId,
        userId: owner.userId,
        familyId: owner.familyId ?? randomUUID(),
        tokenHash: this.tokens.hashOpaqueToken(token),
        expiresAt: new Date(Date.now() + this.ttlMs),
        userAgent: ctx?.userAgent ?? null,
        ip: ctx?.ip ?? null,
      })
      .returning({ id: refreshTokens.id });
    if (!row) throw new Error('refresh token insert returned no row');
    return { token, id: row.id };
  }

  async rotate(presented: string): Promise<RotationResult> {
    const hash = this.tokens.hashOpaqueToken(presented);

    const outcome = await this.db.transaction(async (tx) => {
      // Row lock: two concurrent refreshes with the same token serialise here, and the
      // second one sees it already rotated (→ reuse), never two valid successors.
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).for('update').limit(1);
      if (!row) return { kind: 'invalid' as const };
      if (row.revokedAt) {
        return row.revokedReason === 'rotated'
          ? { kind: 'reused' as const, familyId: row.familyId, tenantId: row.tenantId, userId: row.userId }
          : { kind: 'invalid' as const };
      }
      if (row.expiresAt.getTime() <= Date.now()) return { kind: 'expired' as const };

      const next = await this.issue(tx, { tenantId: row.tenantId, userId: row.userId, familyId: row.familyId });
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: 'rotated', replacedById: next.id })
        .where(eq(refreshTokens.id, row.id));
      return { kind: 'rotated' as const, userId: row.userId, tenantId: row.tenantId, familyId: row.familyId, token: next.token };
    });

    if (outcome.kind === 'reused') {
      // Committed in its own transaction: the caller is about to fail the request,
      // and the revocation must survive that.
      await this.db.transaction(async (tx) => {
        await this.revokeFamily(tx, outcome.familyId, 'reuse_detected');
        await this.audit.record(
          {
            tenantId: outcome.tenantId,
            actor: null,
            action: 'auth.refresh_token_reuse_detected',
            entityType: 'user',
            entityId: outcome.userId,
            after: { family_id: outcome.familyId },
          },
          tx,
        );
      });
      return { kind: 'reused' };
    }
    return outcome;
  }

  /** Logout of one device. Returns the owner, or null when the token is unknown. */
  async revokeByToken(presented: string, reason: RevokeReason): Promise<{ userId: string; tenantId: string } | null> {
    const hash = this.tokens.hashOpaqueToken(presented);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
      if (!row) return null;
      await this.revokeFamily(tx, row.familyId, reason);
      return { userId: row.userId, tenantId: row.tenantId };
    });
  }

  async revokeFamily(tx: Executor, familyId: string, reason: RevokeReason): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeAllForUser(tx: Executor, tenantId: string, userId: string, reason: RevokeReason): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshTokens.tenantId, tenantId), eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
