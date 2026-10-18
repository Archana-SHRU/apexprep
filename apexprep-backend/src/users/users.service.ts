import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { hasPermission, type AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { decodeCursor, toPage, type Page } from '../common/pagination/cursor';
import { DRIZZLE, type Database } from '../database/database.module';
import { LearnerTracksRepository } from '../learner-tracks/learner-tracks.repository';
import { tracks, type UserRow } from '../database/schema';
import { RefreshTokensRevoker } from './refresh-tokens-revoker';
import { toUserDto, type UserDto } from './user.dto';
import type { ChangeUserStatusDto, ListTenantUsersQueryDto, ListUsersQueryDto, UpdateProfileDto } from './dto/users.dto';
import { UsersRepository, type UserPatch } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly revoker: RefreshTokensRevoker,
    private readonly learnerTracks: LearnerTracksRepository,
  ) {}

  async updateOwnProfile(auth: AuthContext, dto: UpdateProfileDto): Promise<UserDto> {
    const current = await this.users.findById(auth.tenantId, auth.userId);
    if (!current) throw AppException.unauthenticated();

    if (dto.primaryTrackId) {
      // Scoped to the caller's tenant: another tenant's track id is simply "not found".
      const [track] = await this.db
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, dto.primaryTrackId), isNull(tracks.deletedAt)))
        .limit(1);
      if (!track) {
        throw AppException.unprocessable('Unknown track', 'REFERENCE_NOT_FOUND', [
          { field: 'primaryTrackId', message: 'track not found' },
        ]);
      }
    }

    const patch: UserPatch = {};
    if (dto.displayName !== undefined) patch.displayName = dto.displayName;
    if (dto.primaryTrackId !== undefined) patch.primaryTrackId = dto.primaryTrackId;
    if (dto.goal !== undefined) patch.goalText = dto.goal === '' ? null : dto.goal;
    if (dto.targetRank !== undefined) patch.targetRank = dto.targetRank;
    if (dto.dailyQuestionGoal !== undefined) patch.dailyQuestionGoal = dto.dailyQuestionGoal;
    if (dto.targetExamDate !== undefined) patch.targetExamDate = dto.targetExamDate;
    if (dto.focusTrackingOptOut !== undefined) patch.focusTrackingOptOut = dto.focusTrackingOptOut;
    if (dto.completeOnboarding && !current.onboardedAt) patch.onboardedAt = new Date();
    if (Object.keys(patch).length === 0) return toUserDto(current);

    const updated = await this.users.update(auth.tenantId, auth.userId, patch);
    if (!updated) throw AppException.unauthenticated();

    // `users.primary_track_id` and `learner_tracks.is_primary` say the same thing, so this endpoint
    // — which predates `learner_tracks` and is still how the frontend sets a primary track — keeps
    // the enrolment side in step. Without this the two would disagree the moment a learner used the
    // older endpoint, and "at most one primary" would hold in each table while naming two tracks.
    if (dto.primaryTrackId) {
      await this.db.transaction(async (tx) => {
        await this.learnerTracks.upsertActive(auth.tenantId, auth.userId, dto.primaryTrackId!, null, tx);
        await this.learnerTracks.makePrimary(auth.tenantId, auth.userId, dto.primaryTrackId!, tx);
      });
    }

    // Every other write in the application leaves an audit row; this one did not, and it is the
    // path that changes `focus_tracking_opt_out` — the student's own privacy choice, which the
    // practice flow reads to decide whether focus events are collected at all. A change to that
    // with no record of who made it or when is the one gap worth closing here. Only the fields
    // actually sent are recorded, and no value is copied that the learner did not supply.
    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'user.profile_updated',
      entityType: 'user',
      entityId: auth.userId,
      before: {
        primaryTrackId: current.primaryTrackId,
        focusTrackingOptOut: current.focusTrackingOptOut,
        onboarded: current.onboardedAt !== null,
      },
      after: {
        fields: Object.keys(patch),
        primaryTrackId: updated.primaryTrackId,
        focusTrackingOptOut: updated.focusTrackingOptOut,
        onboarded: updated.onboardedAt !== null,
      },
    });
    return toUserDto(updated);
  }

  /** Students of the caller's own tenant. */
  async listStudents(auth: AuthContext, q: ListUsersQueryDto): Promise<Page<UserDto>> {
    return this.listTenantUsers(auth.tenantId, { ...q, role: 'STUDENT' });
  }

  /** Users of a tenant. Callers are responsible for authorising access to `tenantId`. */
  async listTenantUsers(tenantId: string, q: ListTenantUsersQueryDto): Promise<Page<UserDto>> {
    const limit = q.limit ?? 20;
    const rows = await this.users.list(tenantId, {
      roles: q.role ? [q.role] : ['STUDENT', 'ADMIN'],
      limit,
      cursor: q.cursor ? decodeCursor(q.cursor) : undefined,
      search: q.search,
    });

    if (rows.length === 0) {
      return toPage(rows, limit, toUserDto);
    }

    const userIds = rows.map((r) => r.id);
    const trackIds = Array.from(new Set(rows.map((r) => r.primaryTrackId).filter((id): id is string => Boolean(id))));

    const [attemptCounts, trackNames] = await Promise.all([
      this.db.execute<{ user_id: string; count: number }>(sql`
        SELECT user_id, count(*)::int AS count
        FROM attempts
        WHERE tenant_id = ${tenantId} AND user_id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})
        GROUP BY user_id
      `),
      trackIds.length > 0
        ? this.db.execute<{ id: string; name: string }>(sql`
            SELECT id, name
            FROM tracks
            WHERE tenant_id = ${tenantId} AND id IN (${sql.join(trackIds.map((id) => sql`${id}::uuid`), sql`, `)})
          `)
        : Promise.resolve({ rows: [] as { id: string; name: string }[] }),
    ]);

    const countMap = new Map(attemptCounts.rows.map((r) => [r.user_id, r.count]));
    const trackMap = new Map(trackNames.rows.map((r) => [r.id, r.name]));

    const mapper = (u: UserRow) =>
      toUserDto(u, {
        questionsSolved: countMap.get(u.id) ?? 0,
        primaryTrackName: u.primaryTrackId ? (trackMap.get(u.primaryTrackId) ?? null) : null,
      });

    return toPage(rows, limit, mapper);
  }

  async getStudent(auth: AuthContext, id: string): Promise<UserDto> {
    const user = await this.users.findById(auth.tenantId, id);
    if (!user || user.role !== 'STUDENT') throw AppException.notFound('Student not found');
    return toUserDto(user);
  }

  /**
   * Enable/disable an account in the caller's tenant. ADMINs may change students only;
   * staff accounts need staff:manage. Disabling revokes every session immediately.
   */
  async changeStatus(auth: AuthContext, id: string, dto: ChangeUserStatusDto): Promise<UserDto> {
    const target = await this.users.findById(auth.tenantId, id);
    if (!target) throw AppException.notFound('User not found');
    if (target.id === auth.userId) throw AppException.unprocessable('You cannot change your own account status');
    if (target.role !== 'STUDENT' && !hasPermission(auth, 'staff:manage')) throw AppException.forbidden();
    if (target.status === dto.status) return toUserDto(target);

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.users.update(
        auth.tenantId,
        id,
        dto.status === 'active' ? { status: 'active', failedLoginCount: 0, lockedUntil: null } : { status: 'disabled' },
        tx,
      );
      // Tenant-scoped update matched nothing: abort before any side effect or audit row.
      if (!row) throw AppException.notFound('User not found');
      if (dto.status === 'disabled') {
        await this.users.bumpTokenVersion(auth.tenantId, id, tx);
        await this.revoker.revokeAllForUser(tx, auth.tenantId, id);
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'user.status_changed',
          entityType: 'user',
          entityId: id,
          before: { status: target.status },
          after: { status: dto.status },
        },
        tx,
      );
      return row;
    });
    if (!updated) throw AppException.notFound('User not found');
    return toUserDto(updated);
  }
}
