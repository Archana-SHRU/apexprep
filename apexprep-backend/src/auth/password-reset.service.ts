import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Env } from '../config/env.schema';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { users, userTokens } from '../database/schema';
import { TokenService } from './token.service';

/** A user may be sent one reset link per minute, however many times the form is submitted. */
export const PASSWORD_RESET_COOLDOWN_MS = 60_000;

/**
 * Password-reset tokens, in user_tokens with purpose 'password_reset'. Only the SHA-256 of a token is
 * stored; the raw token exists in the emailed link and nowhere else. A token is single-use, short-lived
 * (PASSWORD_RESET_TTL_MINUTES), and issuing a new one deletes every unused older one, so only the most
 * recent link works.
 */
@Injectable()
export class PasswordResetService {
  readonly ttlMinutes: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tokens: TokenService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMinutes = config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true });
  }

  /**
   * A new raw token for this user, or null when one was issued less than a minute ago (the per-account
   * rate limit). The user row is locked first so concurrent requests serialise on the cooldown check.
   */
  async issue(user: { id: string; tenantId: string }): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, user.tenantId), eq(users.id, user.id)))
        .for('update');
      const [latest] = await tx
        .select({ createdAt: userTokens.createdAt })
        .from(userTokens)
        .where(and(this.openFor(user), isNull(userTokens.consumedAt)))
        .orderBy(desc(userTokens.createdAt))
        .limit(1);
      if (latest && Date.now() - latest.createdAt.getTime() < PASSWORD_RESET_COOLDOWN_MS) return null;

      await this.discardOpen(tx, user);
      const token = this.tokens.newOpaqueToken();
      await tx.insert(userTokens).values({
        tenantId: user.tenantId,
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: this.tokens.hashOpaqueToken(token),
        expiresAt: new Date(Date.now() + this.ttlMinutes * 60_000),
      });
      return token;
    });
  }

  /** The owner of a valid (known, unused, unexpired) token, without consuming it. */
  async peek(token: string): Promise<{ userId: string; tenantId: string } | null> {
    const [row] = await this.db
      .select({ userId: userTokens.userId, tenantId: userTokens.tenantId })
      .from(userTokens)
      .where(this.valid(token))
      .limit(1);
    return row ?? null;
  }

  /**
   * Marks the token used inside the caller's transaction. Conditional on it still being valid, so two
   * concurrent resets with one link cannot both succeed: the second finds nothing and gets null.
   */
  async consume(tx: Executor, token: string): Promise<{ userId: string; tenantId: string } | null> {
    const [row] = await tx
      .update(userTokens)
      .set({ consumedAt: new Date() })
      .where(this.valid(token))
      .returning({ userId: userTokens.userId, tenantId: userTokens.tenantId });
    return row ?? null;
  }

  /** Deletes the user's other unused reset links (after a successful reset, none should still work). */
  async discardOpen(tx: Executor, user: { id: string; tenantId: string }): Promise<void> {
    await tx.delete(userTokens).where(and(this.openFor(user), isNull(userTokens.consumedAt)));
  }

  private openFor(user: { id: string; tenantId: string }) {
    return and(eq(userTokens.tenantId, user.tenantId), eq(userTokens.userId, user.id), eq(userTokens.purpose, 'password_reset'));
  }

  private valid(token: string) {
    return and(
      eq(userTokens.tokenHash, this.tokens.hashOpaqueToken(token)),
      eq(userTokens.purpose, 'password_reset'),
      isNull(userTokens.consumedAt),
      gt(userTokens.expiresAt, new Date()),
    );
  }
}
