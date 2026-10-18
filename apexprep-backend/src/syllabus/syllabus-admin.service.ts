import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException, type ErrorDetail } from '../common/errors/app-exception';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { isUniqueViolation } from '../database/pg-error';
import { chapters, subjects, subtopics, topics, tracks } from '../database/schema';
import type {
  ChapterDto,
  CreateChapterDto,
  CreateSubjectDto,
  CreateSubtopicDto,
  CreateTopicDto,
  CreateTrackDto,
  SubjectDto,
  SubtopicDto,
  SyllabusLevel,
  TopicDto,
  TrackDto,
  UpdateChapterDto,
  UpdateSubjectDto,
  UpdateSubtopicDto,
  UpdateTopicDto,
  UpdateTrackDto,
} from './dto/syllabus.dto';
import { toChapterDto, toSubjectDto, toSubtopicDto, toTopicDto, toTrackDto } from './syllabus.mappers';
import { SyllabusRepository } from './syllabus.repository';

const PARENT: Record<Exclude<SyllabusLevel, 'track'>, SyllabusLevel> = {
  subject: 'track',
  chapter: 'subject',
  topic: 'chapter',
  subtopic: 'topic',
};

const SLUG_INDEX: Record<SyllabusLevel, string> = {
  track: 'tracks_slug_uq',
  subject: 'subjects_slug_uq',
  chapter: 'chapters_slug_uq',
  topic: 'topics_slug_uq',
  subtopic: 'subtopics_slug_uq',
};

const LABEL: Record<SyllabusLevel, string> = {
  track: 'Track',
  subject: 'Subject',
  chapter: 'Chapter',
  topic: 'Topic',
  subtopic: 'Sub-topic',
};

/** Columns that exist on every level and may not be set to null. */
const REQUIRED_ON_PATCH = ['slug', 'name', 'sortOrder', 'status'] as const;

function rejectNulls(dto: object): void {
  const bad: ErrorDetail[] = REQUIRED_ON_PATCH.filter((k) => (dto as Record<string, unknown>)[k] === null).map((k) => ({
    field: k,
    message: `${k} cannot be null`,
  }));
  if (bad.length) throw AppException.validation(bad);
}

/** Keys of `patch` whose values differ from `current`, for a compact audit diff. */
function diff(current: Record<string, unknown>, patch: Record<string, unknown>): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (JSON.stringify(current[k] ?? null) !== JSON.stringify(v)) {
      before[k] = current[k] ?? null;
      after[k] = v;
    }
  }
  return { before, after };
}

/**
 * Content-admin writes to the syllabus tree. Every write:
 *  - is scoped to the caller's tenant (ids from other tenants answer 404);
 *  - locks the parent row (FOR SHARE) while inserting a child, and the node itself (FOR
 *    UPDATE) while deleting it, so a child can't be added under a node being deleted;
 *  - is audited in the same transaction;
 *  - maps duplicate slugs among live siblings to 409 SLUG_TAKEN.
 * Deletes are soft and refuse (409 NODE_NOT_EMPTY) while live children, questions or
 * content blocks remain. Nodes can't be moved to another parent.
 */

/**
 * A grade belongs to a track that is about a grade.
 *
 * Migration 0013 enforces this (`tracks_grade_needs_school_kind`), but a CHECK violation surfaces as
 * "the request violates a data rule", which tells an admin nothing about which rule or which field.
 * Validating here names the field; the constraint stays as the backstop for anything that reaches
 * the table another way.
 */
function assertGradeMatchesKind(kind: string | null | undefined, gradeOrdinal: number | null | undefined): void {
  if (gradeOrdinal === null || gradeOrdinal === undefined) return;
  if (kind === 'school') return;
  throw AppException.validation([
    {
      field: 'gradeOrdinal',
      message: `a grade applies to a school track, so kind must be 'school' (it is ${kind ? `'${kind}'` : 'not set'})`,
    },
  ]);
}

@Injectable()
export class SyllabusAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: SyllabusRepository,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- tracks

  createTrack(auth: AuthContext, dto: CreateTrackDto): Promise<TrackDto> {
    assertGradeMatchesKind(dto.kind, dto.gradeOrdinal);
    return this.write('track', async (tx) => {
      const [row] = await tx
        .insert(tracks)
        .values({
          tenantId: auth.tenantId,
          slug: dto.slug,
          name: dto.name,
          shortName: dto.shortName ?? null,
          description: dto.description ?? null,
          examYear: dto.examYear ?? null,
          examDate: dto.examDate ?? null,
          // The learning context (migration 0013). Nothing is defaulted: a track the admin does not
          // categorise stays uncategorised, because guessing 'competitive_exam' here is exactly the
          // assumption the generalisation removes.
          kind: dto.kind ?? null,
          educationStage: dto.educationStage ?? null,
          gradeLabel: dto.gradeLabel ?? null,
          gradeOrdinal: dto.gradeOrdinal ?? null,
          examFamily: dto.examFamily ?? null,
          curriculum: dto.curriculum ?? null,
          locale: dto.locale ?? null,
          sortOrder: dto.sortOrder ?? 0,
          status: dto.status ?? 'draft',
        })
        .returning();
      const out = toTrackDto(row!);
      await this.recordCreated(auth, 'track', out.id, out, tx);
      return out;
    });
  }

  updateTrack(auth: AuthContext, id: string, dto: UpdateTrackDto): Promise<TrackDto> {
    rejectNulls(dto);
    return this.write('track', async (tx) => {
      const [current] = await tx.select().from(tracks).where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, id), isNull(tracks.deletedAt))).for('update');
      if (!current) throw AppException.notFound('Track not found');
      // Checked against the values the row will *have*, not only the ones in the patch: setting a
      // grade on an already-school track is fine, and changing the kind away from school while a
      // grade is set is not.
      assertGradeMatchesKind(dto.kind ?? current.kind, dto.gradeOrdinal ?? current.gradeOrdinal);
      const d = diff(toTrackDto(current) as unknown as Record<string, unknown>, dto as Record<string, unknown>);
      if (Object.keys(d.after).length === 0) return toTrackDto(current);
      const [row] = await tx.update(tracks).set(d.after as Partial<typeof tracks.$inferInsert>).where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, id))).returning();
      await this.recordUpdated(auth, 'track', id, d, tx);
      return toTrackDto(row!);
    });
  }

  deleteTrack(auth: AuthContext, id: string): Promise<void> {
    return this.softDelete(auth, 'track', id, (tx) => tx.update(tracks).set({ deletedAt: sql`now()` }).where(and(eq(tracks.tenantId, auth.tenantId), eq(tracks.id, id))));
  }

  // ---------------------------------------------------------------- subjects

  createSubject(auth: AuthContext, trackId: string, dto: CreateSubjectDto): Promise<SubjectDto> {
    return this.write('subject', async (tx) => {
      await this.lockParent('subject', auth.tenantId, trackId, tx);
      const [row] = await tx
        .insert(subjects)
        .values({
          tenantId: auth.tenantId,
          trackId,
          slug: dto.slug,
          name: dto.name,
          colorHex: dto.colorHex ?? null,
          sortOrder: dto.sortOrder ?? 0,
          status: dto.status ?? 'draft',
        })
        .returning();
      const out = toSubjectDto(row!);
      await this.recordCreated(auth, 'subject', out.id, out, tx);
      return out;
    });
  }

  updateSubject(auth: AuthContext, id: string, dto: UpdateSubjectDto): Promise<SubjectDto> {
    rejectNulls(dto);
    return this.write('subject', async (tx) => {
      const [current] = await tx
        .select()
        .from(subjects)
        .where(and(eq(subjects.tenantId, auth.tenantId), eq(subjects.id, id), isNull(subjects.deletedAt)))
        .for('update');
      if (!current) throw AppException.notFound('Subject not found');
      const d = diff(toSubjectDto(current) as unknown as Record<string, unknown>, dto as Record<string, unknown>);
      if (Object.keys(d.after).length === 0) return toSubjectDto(current);
      const [row] = await tx.update(subjects).set(d.after as Partial<typeof subjects.$inferInsert>).where(and(eq(subjects.tenantId, auth.tenantId), eq(subjects.id, id))).returning();
      await this.recordUpdated(auth, 'subject', id, d, tx);
      return toSubjectDto(row!);
    });
  }

  deleteSubject(auth: AuthContext, id: string): Promise<void> {
    return this.softDelete(auth, 'subject', id, (tx) => tx.update(subjects).set({ deletedAt: sql`now()` }).where(and(eq(subjects.tenantId, auth.tenantId), eq(subjects.id, id))));
  }

  // ---------------------------------------------------------------- chapters

  createChapter(auth: AuthContext, subjectId: string, dto: CreateChapterDto): Promise<ChapterDto> {
    return this.write('chapter', async (tx) => {
      await this.lockParent('chapter', auth.tenantId, subjectId, tx);
      const [row] = await tx
        .insert(chapters)
        .values({
          tenantId: auth.tenantId,
          subjectId,
          slug: dto.slug,
          name: dto.name,
          weightagePct: dto.weightagePct ?? null,
          sortOrder: dto.sortOrder ?? 0,
          status: dto.status ?? 'draft',
        })
        .returning();
      const out = toChapterDto(row!);
      await this.recordCreated(auth, 'chapter', out.id, out, tx);
      return out;
    });
  }

  updateChapter(auth: AuthContext, id: string, dto: UpdateChapterDto): Promise<ChapterDto> {
    rejectNulls(dto);
    return this.write('chapter', async (tx) => {
      const [current] = await tx
        .select()
        .from(chapters)
        .where(and(eq(chapters.tenantId, auth.tenantId), eq(chapters.id, id), isNull(chapters.deletedAt)))
        .for('update');
      if (!current) throw AppException.notFound('Chapter not found');
      const d = diff(toChapterDto(current) as unknown as Record<string, unknown>, dto as Record<string, unknown>);
      if (Object.keys(d.after).length === 0) return toChapterDto(current);
      const [row] = await tx.update(chapters).set(d.after as Partial<typeof chapters.$inferInsert>).where(and(eq(chapters.tenantId, auth.tenantId), eq(chapters.id, id))).returning();
      await this.recordUpdated(auth, 'chapter', id, d, tx);
      return toChapterDto(row!);
    });
  }

  deleteChapter(auth: AuthContext, id: string): Promise<void> {
    return this.softDelete(auth, 'chapter', id, (tx) => tx.update(chapters).set({ deletedAt: sql`now()` }).where(and(eq(chapters.tenantId, auth.tenantId), eq(chapters.id, id))));
  }

  // ---------------------------------------------------------------- topics

  createTopic(auth: AuthContext, chapterId: string, dto: CreateTopicDto): Promise<TopicDto> {
    return this.write('topic', async (tx) => {
      await this.lockParent('topic', auth.tenantId, chapterId, tx);
      const [row] = await tx
        .insert(topics)
        .values({ tenantId: auth.tenantId, chapterId, slug: dto.slug, name: dto.name, sortOrder: dto.sortOrder ?? 0, status: dto.status ?? 'draft' })
        .returning();
      const out = toTopicDto(row!);
      await this.recordCreated(auth, 'topic', out.id, out, tx);
      return out;
    });
  }

  updateTopic(auth: AuthContext, id: string, dto: UpdateTopicDto): Promise<TopicDto> {
    rejectNulls(dto);
    return this.write('topic', async (tx) => {
      const [current] = await tx.select().from(topics).where(and(eq(topics.tenantId, auth.tenantId), eq(topics.id, id), isNull(topics.deletedAt))).for('update');
      if (!current) throw AppException.notFound('Topic not found');
      const d = diff(toTopicDto(current) as unknown as Record<string, unknown>, dto as Record<string, unknown>);
      if (Object.keys(d.after).length === 0) return toTopicDto(current);
      const [row] = await tx.update(topics).set(d.after as Partial<typeof topics.$inferInsert>).where(and(eq(topics.tenantId, auth.tenantId), eq(topics.id, id))).returning();
      await this.recordUpdated(auth, 'topic', id, d, tx);
      return toTopicDto(row!);
    });
  }

  deleteTopic(auth: AuthContext, id: string): Promise<void> {
    return this.softDelete(auth, 'topic', id, (tx) => tx.update(topics).set({ deletedAt: sql`now()` }).where(and(eq(topics.tenantId, auth.tenantId), eq(topics.id, id))));
  }

  // ---------------------------------------------------------------- subtopics

  createSubtopic(auth: AuthContext, topicId: string, dto: CreateSubtopicDto): Promise<SubtopicDto> {
    return this.write('subtopic', async (tx) => {
      await this.lockParent('subtopic', auth.tenantId, topicId, tx);
      const [row] = await tx
        .insert(subtopics)
        .values({
          tenantId: auth.tenantId,
          topicId,
          slug: dto.slug,
          name: dto.name,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder ?? 0,
          status: dto.status ?? 'draft',
        })
        .returning();
      const out = toSubtopicDto(row!);
      await this.recordCreated(auth, 'subtopic', out.id, out, tx);
      return out;
    });
  }

  updateSubtopic(auth: AuthContext, id: string, dto: UpdateSubtopicDto): Promise<SubtopicDto> {
    rejectNulls(dto);
    return this.write('subtopic', async (tx) => {
      const [current] = await tx
        .select()
        .from(subtopics)
        .where(and(eq(subtopics.tenantId, auth.tenantId), eq(subtopics.id, id), isNull(subtopics.deletedAt)))
        .for('update');
      if (!current) throw AppException.notFound('Sub-topic not found');
      const d = diff(toSubtopicDto(current) as unknown as Record<string, unknown>, dto as Record<string, unknown>);
      if (Object.keys(d.after).length === 0) return toSubtopicDto(current);
      const [row] = await tx.update(subtopics).set(d.after as Partial<typeof subtopics.$inferInsert>).where(and(eq(subtopics.tenantId, auth.tenantId), eq(subtopics.id, id))).returning();
      await this.recordUpdated(auth, 'subtopic', id, d, tx);
      return toSubtopicDto(row!);
    });
  }

  deleteSubtopic(auth: AuthContext, id: string): Promise<void> {
    return this.softDelete(auth, 'subtopic', id, (tx) => tx.update(subtopics).set({ deletedAt: sql`now()` }).where(and(eq(subtopics.tenantId, auth.tenantId), eq(subtopics.id, id))));
  }

  // ---------------------------------------------------------------- shared

  /** Runs a write in a transaction and turns a duplicate slug into 409 SLUG_TAKEN. */
  private async write<T>(level: SyllabusLevel, fn: (tx: Executor) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(fn);
    } catch (err) {
      if (isUniqueViolation(err, SLUG_INDEX[level])) {
        throw AppException.conflict(`Another ${LABEL[level].toLowerCase()} here already uses this slug`, 'SLUG_TAKEN');
      }
      throw err;
    }
  }

  private async lockParent(level: Exclude<SyllabusLevel, 'track'>, tenantId: string, parentId: string, tx: Executor): Promise<void> {
    const parent = PARENT[level];
    if (!(await this.repo.lockLiveNode(parent, tenantId, parentId, tx, 'share'))) {
      throw AppException.notFound(`${LABEL[parent]} not found`);
    }
  }

  private async softDelete(auth: AuthContext, level: SyllabusLevel, id: string, del: (tx: Executor) => Promise<unknown>): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!(await this.repo.lockLiveNode(level, auth.tenantId, id, tx, 'update'))) throw AppException.notFound(`${LABEL[level]} not found`);
      const dependents = await this.repo.liveDependents(level, auth.tenantId, id, tx);
      const blocking = Object.entries(dependents).filter(([, n]) => n > 0);
      if (blocking.length > 0) {
        throw new AppException(
          HttpStatus.CONFLICT,
          'NODE_NOT_EMPTY',
          `${LABEL[level]} still has ${blocking.map(([k, n]) => `${n} ${k}`).join(' and ')}; delete or move them first`,
          blocking.map(([k, n]) => ({ field: k, message: `${n} live` })),
        );
      }
      await del(tx);
      await this.audit.record({ tenantId: auth.tenantId, action: `${level}.deleted`, entityType: level, entityId: id }, tx);
    });
  }

  private recordCreated(auth: AuthContext, level: SyllabusLevel, id: string, after: object, tx: Executor): Promise<void> {
    return this.audit.record({ tenantId: auth.tenantId, action: `${level}.created`, entityType: level, entityId: id, after: { ...after } }, tx);
  }

  private recordUpdated(
    auth: AuthContext,
    level: SyllabusLevel,
    id: string,
    d: { before: Record<string, unknown>; after: Record<string, unknown> },
    tx: Executor,
  ): Promise<void> {
    return this.audit.record({ tenantId: auth.tenantId, action: `${level}.updated`, entityType: level, entityId: id, before: d.before, after: d.after }, tx);
  }
}
