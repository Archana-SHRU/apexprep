import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { chapters, subjects, subtopics, topics, type SyllabusSuggestionRow } from '../database/schema';
import type { ApproveSuggestionDto, ApprovedSuggestionDto, RejectSuggestionDto, SuggestionLevelDto, SyllabusSuggestionDto, SyllabusSuggestionListDto } from './dto/ingestion.dto';
import { isGrounded, matchLevel, slugFor, type ExistingNode, type ExistingTree, type Level } from './hierarchy';
import { IngestionRepository } from './ingestion.repository';
import { SyllabusSuggestionsRepository } from './syllabus-suggestions.repository';

const LEVEL_LABEL: Record<Level, string> = { chapter: 'Chapter', topic: 'Topic', subtopic: 'Sub-topic' };

/**
 * The human decision on a syllabus suggestion — the only place ingestion can lead to a syllabus node.
 *
 * Approving means "this chapter → topic → sub-topic is right". In one transaction it reuses every level
 * that already exists (re-matched now, so a level another approval just created is reused rather than
 * duplicated), creates only the missing ones — published, under the uploaded track and subject, with
 * names that must appear in the uploaded PDF — publishes any reused draft level on the path, files the
 * linked blocks under the sub-topic and closes the "waiting for approval" tasks. It does **not** approve
 * or publish the blocks: each still goes through the normal review and quality gates.
 *
 * Rejecting records who and why, creates nothing, and leaves the blocks unmapped for a person to file.
 */
@Injectable()
export class SyllabusSuggestionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: IngestionRepository,
    private readonly suggestions: SyllabusSuggestionsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, jobId: string): Promise<SyllabusSuggestionListDto> {
    const job = await this.repo.findJob(auth.tenantId, jobId);
    if (!job) throw AppException.notFound('Ingestion job not found');
    const rows = await this.suggestions.ofJob(auth.tenantId, jobId);
    const out: SyllabusSuggestionDto[] = [];
    const trees = new Map<string, ExistingTree>();
    for (const row of rows) {
      if (!trees.has(row.subjectId)) trees.set(row.subjectId, await this.suggestions.subjectTree(auth.tenantId, row.subjectId));
      out.push(await this.toDto(auth, row, jobId, trees.get(row.subjectId)!));
    }
    return { hierarchy: job.hierarchy ?? null, suggestions: out };
  }

  async approve(auth: AuthContext, jobId: string, suggestionId: string, dto: ApproveSuggestionDto): Promise<ApprovedSuggestionDto> {
    const result = await this.db.transaction(async (tx) => {
      const { suggestion, subject } = await this.requirePending(auth, jobId, suggestionId, tx);
      // Serialises approvals within a subject, so two suggestions sharing a new chapter cannot both create it.
      await tx.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.tenantId, auth.tenantId), eq(subjects.id, subject.subjectId))).for('update');

      const names: Record<Level, string | null> = {
        chapter: dto.chapterName ?? suggestion.chapterName,
        topic: dto.topicName ?? suggestion.topicName,
        subtopic: dto.subtopicName ?? suggestion.subtopicName,
      };
      const missing = (Object.keys(names) as Level[]).filter((l) => !names[l]);
      if (missing.length > 0) {
        throw AppException.validation(
          missing.map((l) => ({ field: `${l}Name`, message: `the PDF does not state the ${LEVEL_LABEL[l].toLowerCase()}; enter it as the PDF prints it` })),
        );
      }

      const documentText = await this.documentText(auth.tenantId, [jobId, suggestion.jobId], tx);
      const tree = await this.suggestions.subjectTree(auth.tenantId, subject.subjectId, tx);
      const created: string[] = [];
      const published: string[] = [];

      const resolve = async (level: Level, parentId: string, siblings: readonly ExistingNode[], preset: string | null, edited: boolean) => {
        const name = names[level]!;
        // The id found at detection is kept unless the admin renamed the level or the node has gone.
        const presetNode = !edited && preset ? siblings.find((n) => n.id === preset && n.status !== 'archived') : undefined;
        const match = presetNode ? { existingId: presetNode.id, existingStatus: presetNode.status } : matchLevel(name, siblings);
        if (match.existingId) {
          if (match.existingStatus === 'draft') {
            await this.publishDraft(auth, level, match.existingId, tx);
            published.push(level);
          }
          return { id: match.existingId, reused: true };
        }
        if (!isGrounded(name, documentText)) {
          throw AppException.unprocessable(`"${name}" does not appear in the uploaded PDF`, 'NAME_NOT_GROUNDED', [
            { field: `${level}Name`, message: 'a new syllabus name must be text the uploaded PDF contains; use the Syllabus page to author other names' },
          ]);
        }
        const id = await this.createNode(auth, level, parentId, name, suggestion, tx);
        created.push(level);
        return { id, reused: false };
      };

      const chapter = await resolve('chapter', subject.subjectId, tree.chapters, suggestion.existingChapterId, dto.chapterName !== undefined);
      const chapterTopics = tree.chapters.find((c) => c.id === chapter.id)?.topics ?? [];
      const topic = await resolve('topic', chapter.id, chapterTopics, suggestion.existingTopicId, dto.topicName !== undefined);
      const topicSubtopics = chapterTopics.find((t) => t.id === topic.id)?.subtopics ?? [];
      const subtopic = await resolve('subtopic', topic.id, topicSubtopics, suggestion.existingSubtopicId, dto.subtopicName !== undefined);

      // File the waiting blocks. Only blocks still unmapped and still in review: a block someone has
      // since filed, published, rejected or superseded is left exactly as they left it.
      const linked = await this.suggestions.blocksOf(auth.tenantId, suggestion.id, null, tx);
      const toMap = linked.filter((b) => b.subtopicId === null && !['published', 'rejected', 'superseded'].includes(b.status)).map((b) => b.id);
      for (const blockId of toMap) {
        await this.repo.updateBlock(auth.tenantId, blockId, { subtopicId: subtopic.id, taggingConfidence: 1 }, tx);
      }
      await this.suggestions.stamp(auth.tenantId, suggestion.id, toMap, tx, { approvedSubtopicId: subtopic.id, needsApproval: false });
      await this.closeWaitingTasks(auth, suggestion.id, linked.map((b) => b.id), `syllabus suggestion approved: filed under ${names.chapter} › ${names.topic} › ${names.subtopic}`, tx);

      const updated = await this.suggestions.update(
        auth.tenantId,
        suggestion.id,
        {
          status: 'approved',
          chapterName: names.chapter,
          topicName: names.topic,
          subtopicName: names.subtopic,
          existingChapterId: chapter.reused ? chapter.id : null,
          existingTopicId: topic.reused ? topic.id : null,
          existingSubtopicId: subtopic.reused ? subtopic.id : null,
          createdChapterId: chapter.reused ? null : chapter.id,
          createdTopicId: topic.reused ? null : topic.id,
          createdSubtopicId: subtopic.reused ? null : subtopic.id,
          reviewedBy: auth.userId,
          reviewedAt: sql`now()`,
        },
        tx,
      );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'syllabus_suggestion.approved',
          entityType: 'syllabus_suggestion',
          entityId: suggestion.id,
          before: { chapter: suggestion.chapterName, topic: suggestion.topicName, subtopic: suggestion.subtopicName },
          after: {
            jobId,
            chapter: { name: names.chapter, id: chapter.id, created: !chapter.reused },
            topic: { name: names.topic, id: topic.id, created: !topic.reused },
            subtopic: { name: names.subtopic, id: subtopic.id, created: !subtopic.reused },
            publishedDrafts: published,
            blocksMapped: toMap.length,
          },
        },
        tx,
      );
      return { row: updated, subtopicId: subtopic.id, blocksMapped: toMap.length, created };
    });

    const tree = await this.suggestions.subjectTree(auth.tenantId, result.row.subjectId);
    return { suggestion: await this.toDto(auth, result.row, jobId, tree), subtopicId: result.subtopicId, blocksMapped: result.blocksMapped, created: result.created };
  }

  async reject(auth: AuthContext, jobId: string, suggestionId: string, dto: RejectSuggestionDto): Promise<SyllabusSuggestionDto> {
    const row = await this.db.transaction(async (tx) => {
      const { suggestion } = await this.requirePending(auth, jobId, suggestionId, tx);
      const updated = await this.suggestions.update(
        auth.tenantId,
        suggestion.id,
        { status: 'rejected', reviewedBy: auth.userId, reviewedAt: sql`now()`, rejectionReason: dto.reason ?? null },
        tx,
      );
      // The blocks stay unmapped, in review. Their tasks now say what is left to do.
      const linked = await this.suggestions.blocksOf(auth.tenantId, suggestion.id, null, tx);
      for (const block of linked) {
        for (const task of await this.repo.tasksOfBlock(auth.tenantId, block.id, tx)) {
          if ((task.status === 'open' || task.status === 'in_progress') && task.suggestion?.syllabusSuggestionId === suggestion.id) {
            await this.repo.updateReviewTask(auth.tenantId, task.id, { reason: 'the suggested syllabus was rejected; choose an existing sub-topic for this block, or reject it' }, tx);
          }
        }
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'syllabus_suggestion.rejected',
          entityType: 'syllabus_suggestion',
          entityId: suggestion.id,
          after: { jobId, reason: dto.reason ?? null, chapter: suggestion.chapterName, topic: suggestion.topicName, subtopic: suggestion.subtopicName, blocks: linked.length },
        },
        tx,
      );
      return updated;
    });
    return this.toDto(auth, row, jobId, await this.suggestions.subjectTree(auth.tenantId, row.subjectId));
  }

  // ---------------------------------------------------------------- pieces

  /**
   * The suggestion, locked, if it belongs to this tenant and this job (proposed by it, or with its
   * blocks linked) and is still pending; and its subject, if that still exists under the same track.
   */
  private async requirePending(auth: AuthContext, jobId: string, suggestionId: string, tx: Executor) {
    const job = await this.repo.findJob(auth.tenantId, jobId, tx);
    if (!job) throw AppException.notFound('Ingestion job not found');
    const suggestion = await this.suggestions.find(auth.tenantId, suggestionId, tx, true);
    const belongs = suggestion && (suggestion.jobId === jobId || (await this.suggestions.blocksOf(auth.tenantId, suggestion.id, jobId, tx)).length > 0);
    if (!suggestion || !belongs) throw AppException.notFound('Syllabus suggestion not found');
    if (suggestion.status !== 'pending') {
      throw AppException.conflict(`this suggestion has already been ${suggestion.status}`, 'INVALID_STATE');
    }
    const asset = await this.repo.findAsset(auth.tenantId, job.assetId, tx);
    if (!asset || asset.subjectId !== suggestion.subjectId) {
      throw AppException.conflict('this suggestion was made for a different subject than this upload', 'INVALID_STATE');
    }
    const subject = await this.suggestions.subjectContext(auth.tenantId, suggestion.subjectId, tx);
    if (!subject || subject.trackId !== suggestion.trackId) {
      throw AppException.conflict('the subject this upload was made for no longer exists under its track', 'INVALID_STATE');
    }
    return { suggestion, subject };
  }

  /** The extracted text of the uploads involved: what every new name is checked against. */
  private async documentText(tenantId: string, jobIds: readonly string[], tx: Executor): Promise<string> {
    const texts: string[] = [];
    for (const id of new Set(jobIds)) for (const page of await this.repo.pagesOfJob(tenantId, id, tx)) texts.push(page.textContent);
    return texts.join('\n');
  }

  private async createNode(auth: AuthContext, level: Level, parentId: string, name: string, suggestion: SyllabusSuggestionRow, tx: Executor): Promise<string> {
    const taken = await this.suggestions.takenSlugs(level, auth.tenantId, parentId, tx);
    const base = slugFor(name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const sortOrder = await this.suggestions.nextSortOrder(level, auth.tenantId, parentId, tx);
    const common = { tenantId: auth.tenantId, slug, name: name.trim(), sortOrder, status: 'published' as const };
    const [row] =
      level === 'chapter'
        ? await tx.insert(chapters).values({ ...common, subjectId: parentId }).returning({ id: chapters.id })
        : level === 'topic'
          ? await tx.insert(topics).values({ ...common, chapterId: parentId }).returning({ id: topics.id })
          : await tx.insert(subtopics).values({ ...common, topicId: parentId }).returning({ id: subtopics.id });
    const id = row!.id;
    // The same audit action the Syllabus page writes, so a node's history reads the same however it was made.
    await this.audit.record(
      { tenantId: auth.tenantId, action: `${level}.created`, entityType: level, entityId: id, after: { name: common.name, slug, status: 'published', parentId, fromSyllabusSuggestion: suggestion.id } },
      tx,
    );
    return id;
  }

  private async publishDraft(auth: AuthContext, level: Level, id: string, tx: Executor): Promise<void> {
    const table = level === 'chapter' ? chapters : level === 'topic' ? topics : subtopics;
    await tx.update(table).set({ status: 'published' }).where(and(eq(table.tenantId, auth.tenantId), eq(table.id, id), eq(table.status, 'draft')));
    await this.audit.record(
      { tenantId: auth.tenantId, action: `${level}.updated`, entityType: level, entityId: id, before: { status: 'draft' }, after: { status: 'published', reason: 'approved syllabus suggestion' } },
      tx,
    );
  }

  private async closeWaitingTasks(auth: AuthContext, suggestionId: string, blockIds: readonly string[], note: string, tx: Executor): Promise<void> {
    for (const blockId of blockIds) {
      for (const task of await this.repo.tasksOfBlock(auth.tenantId, blockId, tx)) {
        if ((task.status === 'open' || task.status === 'in_progress') && task.suggestion?.syllabusSuggestionId === suggestionId) {
          await this.repo.updateReviewTask(auth.tenantId, task.id, { status: 'resolved', resolvedBy: auth.userId, resolvedAt: sql`now()`, resolutionNote: note.slice(0, 2000) }, tx);
        }
      }
    }
  }

  private async toDto(auth: AuthContext, row: SyllabusSuggestionRow, jobId: string, tree: ExistingTree): Promise<SyllabusSuggestionDto> {
    const subject = await this.suggestions.subjectContext(auth.tenantId, row.subjectId);
    const linked = await this.suggestions.blocksOf(auth.tenantId, row.id, jobId);
    const nodes = new Map<string, ExistingNode>();
    for (const c of tree.chapters) {
      nodes.set(c.id, c);
      for (const t of c.topics) {
        nodes.set(t.id, t);
        for (const st of t.subtopics) nodes.set(st.id, st);
      }
    }
    const detected = (row.evidence.detected ?? {}) as Record<string, Record<string, unknown> | null>;
    const level = (l: Level, name: string | null, existingId: string | null, createdId: string | null): SuggestionLevelDto => {
      const existing = existingId ? nodes.get(existingId) : undefined;
      return {
        name,
        state: name === null ? 'unresolved' : existingId || (row.status === 'approved' && !createdId) ? 'existing' : 'new',
        existingId,
        existingName: existing?.name ?? null,
        existingStatus: existing?.status ?? null,
        createdId,
        evidence: detected[l] ?? null,
      };
    };
    return {
      id: row.id,
      jobId: row.jobId,
      status: row.status,
      trackId: row.trackId,
      trackName: subject?.trackName ?? '',
      subjectId: row.subjectId,
      subjectName: subject?.subjectName ?? '',
      chapter: level('chapter', row.chapterName, row.existingChapterId, row.createdChapterId),
      topic: level('topic', row.topicName, row.existingTopicId, row.createdTopicId),
      subtopic: level('subtopic', row.subtopicName, row.existingSubtopicId, row.createdSubtopicId),
      confidence: row.confidence,
      mappingReason: row.mappingReason,
      evidence: { method: row.evidence.method ?? null, notes: row.evidence.notes ?? [] },
      linkedBlocks: linked.length,
      needsNames: !row.chapterName || !row.topicName || !row.subtopicName,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
