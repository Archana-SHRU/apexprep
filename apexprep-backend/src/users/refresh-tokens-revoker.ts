import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { refreshTokens } from '../database/schema';

/**
 * Revokes a user's sessions. Lives in the users module (not auth) so account
 * administration can end sessions without a circular module dependency on AuthModule.
 */
@Injectable()
export class RefreshTokensRevoker {
  async revokeAllForUser(tx: Executor, tenantId: string, userId: string): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: 'admin' })
      .where(and(eq(refreshTokens.tenantId, tenantId), eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
