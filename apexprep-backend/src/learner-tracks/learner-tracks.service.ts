import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import type { LearnerTrackRow, TrackRow } from '../database/schema';
import { toTrackDto } from '../syllabus/syllabus.mappers';
import type { EnrolTrackDto, LearnerTrackDto, UpdateEnrolmentDto } from './dto/learner-tracks.dto';
import { LearnerTracksRepository } from './learner-tracks.repository';

/**
 * A learner's tracks.
 *
 * Before migration 0013 a learner had exactly one, `users.primary_track_id`, which cannot express
 * "Class 10 Mathematics, JEE Foundation and Olympiad Mathematics" at all. `learner_tracks` is that
 * relation; this service is the only thing that writes it.
 *
 * Two decisions run through everything here.
 *
 * **`users.primary_track_id` is not replaced, it is kept in step.** It is read by existing code and
 * returned by the profile endpoint, so removing it would be a breaking change for the frontend for no
 * gain. Every path that changes which track is primary writes both, in one transaction, so the two
 * can never disagree. The database enforces its half: `learner_tracks_one_primary_uq` makes "at most
 * one primary" a constraint rather than a habit.
 *
 * **Enrolments are materialised lazily, never back-filled.** Migration 0013 deliberately creates no
 * rows: inventing an enrolment for every existing learner would be a guess written into their data,
 * and a migration that touches every row of `users` is one that has to be undone by hand if the guess
 * is wrong. Instead `ensure` runs at the start of each operation and converts the learner's existing
 * `primary_track_id` into the enrolment row it always implied — once, idempotently, and only for a
 * learner who actually uses the feature. A learner who never does keeps behaving exactly as before.
 *
 * What this service deliberately does **not** do:
 *
 *   * It does not touch mastery. `ability_scores` is unique per `(tenant_id, user_id, subtopic_id)`
 *     and a sub-topic belongs to exactly one track, so a learner in three tracks already has three
 *     independent sets of mastery and no code path can merge them. Enrolling in a second track
 *     cannot move a learner's ability in the first.
 *   * It does not decide what a learner may practise. Practice is authorised per sub-topic through
 *     the published syllabus, exactly as before; an enrolment records intent, not access. Making
 *     enrolment a gate would change who can practise what, which is not a Phase 8 requirement and
 *     would silently lock out every learner with no enrolment row.
 *   * It promotes nothing on leaving. When a learner leaves their primary track they are left with no
 *     primary rather than having the next one chosen for them: which track matters most is theirs to
 *     say, and no rule for picking is specified.
 */
@Injectable()
export class LearnerTracksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: LearnerTracksRepository,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext): Promise<LearnerTrackDto[]> {
    const rows = await this.db.transaction(async (tx) => {
      await this.ensure(auth, tx);
      return this.repo.listForLearner(auth.tenantId, auth.userId, tx);
    });
    return rows.map((r) => this.toDto(r.enrolment, r.track));
  }

  async enrol(auth: AuthContext, dto: EnrolTrackDto): Promise<LearnerTrackDto> {
    const { enrolment, track, created, madePrimary } = await this.db.transaction(async (tx) => {
      await this.ensure(auth, tx);
      const track = await this.repo.findEnrollableTrack(auth.tenantId, dto.trackId, tx);
      // Scoped to the caller's organisation, so another organisation's track id is simply not found
      // — the same answer a track that does not exist gives.
      if (!track) {
        throw AppException.unprocessable('Unknown track', 'REFERENCE_NOT_FOUND', [
          { field: 'trackId', message: 'track not found' },
        ]);
      }
      if (track.status !== 'published') {
        throw AppException.unprocessable('That track is not open for enrolment yet', 'REFERENCE_NOT_FOUND', [
          { field: 'trackId', message: `track is ${track.status}` },
        ]);
      }

      const existing = await this.repo.findEnrolment(auth.tenantId, auth.userId, dto.trackId, tx);
      const created = existing === undefined || existing.status === 'left';
      let enrolment = await this.repo.upsertActive(auth.tenantId, auth.userId, dto.trackId, dto.goalText ?? null, tx);

      // The first track a learner enrols in becomes their primary one: a learner with tracks and no
      // primary has no sensible home screen, and this is the only case where the choice is forced.
      const total = await this.repo.countEnrolments(auth.tenantId, auth.userId, tx);
      const madePrimary = dto.makePrimary === true || total === 1;
      if (madePrimary) enrolment = await this.repo.makePrimary(auth.tenantId, auth.userId, dto.trackId, tx);

      return { enrolment, track, created, madePrimary };
    });

    await this.audit.record({
      tenantId: auth.tenantId,
      action: created ? 'learner_track.enrolled' : 'learner_track.updated',
      entityType: 'learner_track',
      entityId: enrolment.id,
      after: { trackId: track.id, trackSlug: track.slug, isPrimary: madePrimary, status: enrolment.status },
    });
    return this.toDto(enrolment, track);
  }

  async update(auth: AuthContext, trackId: string, dto: UpdateEnrolmentDto): Promise<LearnerTrackDto> {
    if (dto.isPrimary === false) {
      // There is no "not primary" state to ask for: a learner has one primary track or none, and
      // none is reached by leaving the track. Accepting `false` would mean either silently doing
      // nothing or clearing the primary track through a field that does not say so.
      throw AppException.validation([
        { field: 'isPrimary', message: 'make another track primary instead; a learner always has at most one' },
      ]);
    }

    const { enrolment, track } = await this.db.transaction(async (tx) => {
      await this.ensure(auth, tx);
      const existing = await this.repo.findEnrolment(auth.tenantId, auth.userId, trackId, tx);
      if (!existing) throw AppException.notFound('You are not enrolled in that track');
      if (existing.status === 'left') {
        throw AppException.conflict('You have left that track; enrol again first', 'INVALID_STATE');
      }

      let enrolment = existing;
      if (dto.goalText !== undefined) {
        enrolment = await this.repo.setGoal(auth.tenantId, existing.id, dto.goalText === '' ? null : dto.goalText, tx);
      }
      if (dto.isPrimary === true) enrolment = await this.repo.makePrimary(auth.tenantId, auth.userId, trackId, tx);

      const track = await this.repo.findEnrollableTrack(auth.tenantId, trackId, tx);
      if (!track) throw AppException.notFound('Track not found');
      return { enrolment, track };
    });

    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'learner_track.updated',
      entityType: 'learner_track',
      entityId: enrolment.id,
      after: { trackId, isPrimary: enrolment.isPrimary, fields: Object.keys(dto) },
    });
    return this.toDto(enrolment, track);
  }

  async leave(auth: AuthContext, trackId: string): Promise<LearnerTrackDto> {
    const { enrolment, track, wasPrimary } = await this.db.transaction(async (tx) => {
      await this.ensure(auth, tx);
      const existing = await this.repo.findEnrolment(auth.tenantId, auth.userId, trackId, tx);
      if (!existing) throw AppException.notFound('You are not enrolled in that track');
      const wasPrimary = existing.isPrimary;
      const enrolment = existing.status === 'left' ? existing : await this.repo.leave(auth.tenantId, existing.id, tx);
      // Leaving the primary track leaves the learner with no primary track. Nothing is promoted in
      // its place — see the note on this class.
      if (wasPrimary) await this.repo.setUsersPrimaryTrack(auth.tenantId, auth.userId, null, tx);
      const track = await this.repo.findEnrollableTrack(auth.tenantId, trackId, tx);
      if (!track) throw AppException.notFound('Track not found');
      return { enrolment, track, wasPrimary };
    });

    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'learner_track.left',
      entityType: 'learner_track',
      entityId: enrolment.id,
      after: { trackId, wasPrimary },
    });
    return this.toDto(enrolment, track);
  }

  /**
   * Materialises the enrolment the learner's `users.primary_track_id` already implies.
   *
   * Idempotent and cheap: for a learner who has any enrolment row it is a single count, and for one
   * who has none and no primary track it is a count and a read. It runs inside the caller's
   * transaction so a concurrent request cannot interleave, and `upsertActive` converges on one row
   * even if one does.
   *
   * A deleted track is skipped rather than enrolled in, and a learner pointing at one is simply left
   * with no enrolments — the alternative is an enrolment in something that no longer exists.
   */
  private async ensure(auth: AuthContext, tx: Executor): Promise<void> {
    if ((await this.repo.countEnrolments(auth.tenantId, auth.userId, tx)) > 0) return;
    const primaryTrackId = await this.repo.primaryTrackIdOf(auth.tenantId, auth.userId, tx);
    if (!primaryTrackId) return;
    const track = await this.repo.findEnrollableTrack(auth.tenantId, primaryTrackId, tx);
    if (!track) return;
    await this.repo.upsertActive(auth.tenantId, auth.userId, primaryTrackId, null, tx);
    await this.repo.makePrimary(auth.tenantId, auth.userId, primaryTrackId, tx);
  }

  private toDto(enrolment: LearnerTrackRow, track: TrackRow): LearnerTrackDto {
    return {
      id: enrolment.id,
      trackId: enrolment.trackId,
      isPrimary: enrolment.isPrimary,
      status: enrolment.status,
      goalText: enrolment.goalText,
      enrolledAt: enrolment.enrolledAt.toISOString(),
      leftAt: enrolment.leftAt === null ? null : enrolment.leftAt.toISOString(),
      track: toTrackDto(track),
    };
  }
}
