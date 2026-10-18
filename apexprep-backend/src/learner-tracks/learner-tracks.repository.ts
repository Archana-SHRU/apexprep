import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { learnerTracks, tracks, users, type LearnerTrackRow, type TrackRow } from '../database/schema';

export interface EnrolmentWithTrack {
  enrolment: LearnerTrackRow;
  track: TrackRow;
}

/**
 * Enrolment data access.
 *
 * This repository also owns the one write to `users.primary_track_id`, because the invariant it
 * maintains spans both tables: `learner_tracks.is_primary` and `users.primary_track_id` must name
 * the same track. Splitting that across two owners is how the two drift apart. `users` is otherwise
 * untouched here, and nothing else about a user is read or written.
 */
@Injectable()
export class LearnerTracksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** A track of this organisation that a learner may enrol in, or undefined. */
  async findEnrollableTrack(tenantId: string, trackId: string, tx: Executor = this.db): Promise<TrackRow | undefined> {
    const [row] = await tx
      .select()
      .from(tracks)
      .where(and(eq(tracks.tenantId, tenantId), eq(tracks.id, trackId), isNull(tracks.deletedAt)))
      .limit(1);
    return row;
  }

  async listForLearner(tenantId: string, userId: string, tx: Executor = this.db): Promise<EnrolmentWithTrack[]> {
    const rows = await tx
      .select({ enrolment: learnerTracks, track: tracks })
      .from(learnerTracks)
      .innerJoin(tracks, and(eq(tracks.tenantId, learnerTracks.tenantId), eq(tracks.id, learnerTracks.trackId)))
      .where(and(eq(learnerTracks.tenantId, tenantId), eq(learnerTracks.userId, userId)))
      .orderBy(sql`${learnerTracks.isPrimary} DESC, ${learnerTracks.enrolledAt} DESC`);
    return rows;
  }

  async findEnrolment(
    tenantId: string,
    userId: string,
    trackId: string,
    tx: Executor = this.db,
  ): Promise<LearnerTrackRow | undefined> {
    const [row] = await tx
      .select()
      .from(learnerTracks)
      .where(
        and(eq(learnerTracks.tenantId, tenantId), eq(learnerTracks.userId, userId), eq(learnerTracks.trackId, trackId)),
      )
      .limit(1);
    return row;
  }

  /** The learner's `users.primary_track_id`, which is the pre-0013 way of saying the same thing. */
  async primaryTrackIdOf(tenantId: string, userId: string, tx: Executor = this.db): Promise<string | null | undefined> {
    const [row] = await tx
      .select({ primaryTrackId: users.primaryTrackId })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    return row === undefined ? undefined : row.primaryTrackId;
  }

  async countEnrolments(tenantId: string, userId: string, tx: Executor = this.db): Promise<number> {
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM ${learnerTracks}
       WHERE tenant_id = ${tenantId} AND user_id = ${userId}
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * Inserts the enrolment, or reactivates the one that is already there.
   *
   * `ON CONFLICT (tenant_id, user_id, track_id)` is the point: re-enrolling revives the row the
   * learner already has rather than adding a second history for the same track, and two concurrent
   * requests converge on one row instead of one of them failing on the unique index.
   *
   * `is_primary` is never set here. It is a separate statement so that "at most one primary" is
   * maintained by clearing the old one first, in the same transaction.
   */
  async upsertActive(
    tenantId: string,
    userId: string,
    trackId: string,
    goalText: string | null,
    tx: Executor,
  ): Promise<LearnerTrackRow> {
    const [row] = await tx
      .insert(learnerTracks)
      .values({ tenantId, userId, trackId, goalText, status: 'active', enrolledAt: sql`now()` })
      .onConflictDoUpdate({
        target: [learnerTracks.tenantId, learnerTracks.userId, learnerTracks.trackId],
        set: {
          status: 'active',
          leftAt: null,
          // A goal is only overwritten when one is supplied, so re-enrolling does not silently erase
          // what the learner wrote last time.
          ...(goalText === null ? {} : { goalText }),
        },
      })
      .returning();
    return row!;
  }

  async setGoal(tenantId: string, id: string, goalText: string | null, tx: Executor): Promise<LearnerTrackRow> {
    const [row] = await tx
      .update(learnerTracks)
      .set({ goalText })
      .where(and(eq(learnerTracks.tenantId, tenantId), eq(learnerTracks.id, id)))
      .returning();
    return row!;
  }

  /**
   * Makes one enrolment primary, and makes it the only one.
   *
   * Clearing the others first is required, not tidy: `learner_tracks_one_primary_uq` is a unique
   * index over the primary rows, so setting a second one without clearing the first fails. Both
   * statements and the `users` update are in the caller's transaction, so a learner is never left
   * with two primaries or with the two tables disagreeing.
   */
  async makePrimary(tenantId: string, userId: string, trackId: string, tx: Executor): Promise<LearnerTrackRow> {
    await tx
      .update(learnerTracks)
      .set({ isPrimary: false })
      .where(
        and(
          eq(learnerTracks.tenantId, tenantId),
          eq(learnerTracks.userId, userId),
          eq(learnerTracks.isPrimary, true),
          ne(learnerTracks.trackId, trackId),
        ),
      );
    const [row] = await tx
      .update(learnerTracks)
      .set({ isPrimary: true })
      .where(
        and(eq(learnerTracks.tenantId, tenantId), eq(learnerTracks.userId, userId), eq(learnerTracks.trackId, trackId)),
      )
      .returning();
    await this.setUsersPrimaryTrack(tenantId, userId, trackId, tx);
    return row!;
  }

  /**
   * Records that the learner has left a track.
   *
   * The row is kept — `status = 'left'` with `left_at` — because a learner's history is worth more
   * than the space the row takes, and because re-enrolling should return to the same row rather than
   * start a second one. `is_primary` is cleared, which the `learner_tracks_primary_active` CHECK
   * requires anyway.
   */
  async leave(tenantId: string, id: string, tx: Executor): Promise<LearnerTrackRow> {
    const [row] = await tx
      .update(learnerTracks)
      .set({ status: 'left', leftAt: sql`now()`, isPrimary: false })
      .where(and(eq(learnerTracks.tenantId, tenantId), eq(learnerTracks.id, id)))
      .returning();
    return row!;
  }

  /** The `users` side of the primary-track invariant. */
  async setUsersPrimaryTrack(tenantId: string, userId: string, trackId: string | null, tx: Executor): Promise<void> {
    await tx
      .update(users)
      .set({ primaryTrackId: trackId })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  }
}
