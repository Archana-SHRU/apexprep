import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Env } from '../config/env.schema';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { users, userTokens } from '../database/schema';
import { MailService } from '../mail/mail.service';
import { TokenService } from './token.service';

/**
 * Email verification with single-use tokens (hashed in user_tokens). Issuing a new token
 * discards older unused ones, so only the most recent link works.
 */
@Injectable()
export class EmailVerificationService {
  private readonly ttlMs: number;
  private readonly appUrl: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true }) * 60 * 60 * 1000;
    this.appUrl = config.get('FRONTEND_URL', { infer: true });
  }

  /**
   * Create a token inside the caller's transaction; call the returned function after commit to send the
   * email. Sending is best effort and off the request path (MailService.dispatch).
   */
  async issue(tx: Executor, user: { id: string; tenantId: string; email: string }): Promise<() => void> {
    const token = this.tokens.newOpaqueToken();
    await tx
      .delete(userTokens)
      .where(and(eq(userTokens.userId, user.id), eq(userTokens.purpose, 'email_verification'), isNull(userTokens.consumedAt)));
    await tx.insert(userTokens).values({
      tenantId: user.tenantId,
      userId: user.id,
      purpose: 'email_verification',
      tokenHash: this.tokens.hashOpaqueToken(token),
      expiresAt: new Date(Date.now() + this.ttlMs),
    });
    const link = `${this.appUrl}/verify-email?token=${token}`;
    return () =>
      this.mail.dispatch({
        kind: 'email_verification',
        to: user.email,
        subject: 'Verify your ApexPrep email address',
        text: `Confirm your email address by opening this link:\n\n${link}\n\nThe link expires in ${Math.round(
          this.ttlMs / 3_600_000,
        )} hours. If you did not create an ApexPrep account, ignore this email.`,
      });
  }

  /** Returns true when a valid, unused, unexpired token was consumed. */
  async verify(token: string): Promise<boolean> {
    const hash = this.tokens.hashOpaqueToken(token);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(userTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(userTokens.tokenHash, hash),
            eq(userTokens.purpose, 'email_verification'),
            isNull(userTokens.consumedAt),
            gt(userTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: userTokens.userId, tenantId: userTokens.tenantId });
      if (!row) return false;
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(users.id, row.userId), eq(users.tenantId, row.tenantId), isNull(users.emailVerifiedAt)));
      return true;
    });
  }
}
