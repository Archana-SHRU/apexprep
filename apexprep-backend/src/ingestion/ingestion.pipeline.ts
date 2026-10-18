import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE, type Database } from '../database/database.module';
import type { ContentAssetRow, ContentBlockRow, IngestionJobRow, JobStatus } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { OCR_PROVIDER, OcrUnavailableError, withFormulaPlaceholders, type OcrProvider } from '../pdf/ocr-provider';
import { PdfDocument } from '../pdf/pdf-document';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage';
import type { TrackIdentity } from '../common/learning/track-identity';
import { decideAutoApproval } from './auto-approval';
import { parseIngestionParams, type IngestionParams } from './ingestion-params';
import { IngestionRepository, type ReviewTaskDraft } from './ingestion.repository';
import { JOB_QUEUE, type JobQueue, type QueuedJob } from './job-queue';
import {
  buildHeadingPrompt,
  detectHierarchy,
  detectionFromModel,
  headingCandidates,
  matchPath,
  normalizeName,
  parseHeadingReply,
  type DetectedPath,
  type HierarchyBlock,
  type HierarchyDetection,
  type PathMatch,
} from './hierarchy';
import { mapToSubtopic, type MappingResult } from './mapping';
import { checkBlockGates, checkQuestionGates, referencesDiagram } from './quality-gates';
import { applySolutionAnswer, extractQuestion, sourceDifficultyToLabel, type ExtractedQuestion } from './question-extraction';
import { segmentPages, type PageText, type SegmentedBlock } from './segmentation';
import { matchSolutions, statedAnswerOf, type QuestionCandidate, type SolutionCandidate, type SolutionMatch } from './solution-matching';
import { SyllabusSuggestionsRepository, type SubjectContext } from './syllabus-suggestions.repository';
import { RequestContext } from '../common/request-context/request-context';
import { detectSubjectFromDocument } from './subject-detection';
import { understandBlockWithAi, applyAiUnderstanding, type AiUnderstanding } from './content-understanding';
import { EXTRACTED, isAiTouched, readProvenance, withAi, withInferred, type Provenance } from './provenance';
import { LearningDraftsService } from './learning-drafts.service';
import { QuestionDraftsService } from './question-drafts.service';

/**
 * The ingestion pipeline: what actually happens to an uploaded PDF.
 *
 * Every stage is **idempotent**, because a job can be re-run — by a retry, by an operator, or
 * after the process died mid-flight. Re-running writes the same rows rather than a second set:
 * pages and machine-written blocks are replaced, machine-opened review tasks are replaced, and
 * anything a human has touched is left exactly as they left it
 * (`IngestionRepository.replaceMachineBlocks`). That is the property that makes a crash
 * recoverable instead of destructive.
 *
 * Two rules the pipeline never breaks:
 *
 *   * **It does not create syllabus nodes.** It reads the chapter → topic → sub-topic headings the
 *     PDF prints (`hierarchy.ts`), matches them inside the uploaded subject, and files content under
 *     an existing published sub-topic when the whole path exists. Where a level is missing it writes
 *     a `syllabus_suggestions` row — a proposal, not a node — and the content waits, unmapped, for an
 *     admin to approve it (`SyllabusSuggestionService`). There is no code path from here to a
 *     syllabus insert.
 *   * **It does not publish anything.** It produces blocks, question proposals and review tasks,
 *     and leaves the job `awaiting_review`. Publication is a separate, human-gated step in
 *     `ReviewService`, behind the quality gates.
 *
 * Stage names are mapped onto `ingestion_jobs.status`, whose values migration 0003 fixed before
 * this phase existed. The mapping is in `STAGES` below rather than in a new migration.
 */
/**
 * A block with no sub-topic yet has no track, so it has no Olympiad exemption either: an empty slug
 * and an unset kind match no pattern, and such a block fails the `subtopic` gate anyway.
 */
const UNKNOWN_TRACK: TrackIdentity = { slug: '', kind: null };

@Injectable()
export class IngestionPipeline implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestionPipeline.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly repo: IngestionRepository,
    private readonly suggestions: SyllabusSuggestionsRepository,
    private readonly engineConfig: EngineConfigService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly drafts: LearningDraftsService,
    private readonly questionDrafts: QuestionDraftsService,
  ) {}

  /** Registers the handler once, the way a BullMQ `Worker` would be started. */
  onApplicationBootstrap(): void {
    this.queue.process((job) => this.run(job));
  }

  /**
   * Runs one job to `awaiting_review`, or records why it could not get there.
   *
   * A failure is a first-class outcome: the stage that failed, a stable code and the message are
   * written to the job row so an operator can see what happened without reading logs, and the
   * attempt count is kept so a retry is visible.
   */
  run(queued: QueuedJob): Promise<void> {
    // The pipeline acts for the system, not for whoever's request happened to queue it: a request context carried
    // over from the upload would stamp the uploader's id, address and browser on every row the pipeline audits.
    return RequestContext.run({ requestId: `job:${queued.jobId}` }, () => this.runJob(queued));
  }

  private async runJob(queued: QueuedJob): Promise<void> {
    const { tenantId, jobId } = queued;
    const job = await this.repo.findJob(tenantId, jobId);
    if (!job) {
      this.logger.warn(`ingestion job ${jobId} no longer exists; nothing to do`);
      return;
    }
    if (job.status === 'cancelled' || job.status === 'published') {
      this.logger.log(`ingestion job ${jobId} is ${job.status}; not re-running it`);
      return;
    }

    const asset = await this.repo.findAsset(tenantId, job.assetId);
    if (!asset) {
      await this.fail(job, 'asset_missing', 'the uploaded asset row is gone, so there is nothing to ingest');
      return;
    }

    await this.repo.updateJob(tenantId, jobId, {
      status: 'extracting',
      progressPct: stageProgress('extracting'),
      attemptCount: job.attemptCount + 1,
      startedAt: job.startedAt ?? sql`now()`,
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
    });

    try {
      const params = await this.params(tenantId);
      await this.process(job, asset, params);
    } catch (error) {
      const code = error instanceof PipelineError ? error.code : 'unexpected_error';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ingestion job ${jobId} failed at ${code}: ${message}`);
      await this.fail(job, code, message);
    }
  }

  // ---------------------------------------------------------------- the stages

  private async process(job: IngestionJobRow, asset: ContentAssetRow, params: IngestionParams): Promise<void> {
    const tenantId = job.tenantId;

    // 1. extract — the text layer, page by page.
    const bytes = await this.readAsset(asset);
    const pdf = PdfDocument.parse(bytes);
    const extracted = pdf.extractText();
    if (extracted.length === 0) throw new PipelineError('no_pages', 'the PDF yielded no pages to read');

    // 2. OCR — only the pages whose text layer is too thin to use.
    await this.stage(job, 'ocr');
    const thin = extracted.filter((p) => p.text.trim().length < params.ingestion.ocr_min_page_chars);
    const pages: PageText[] = [];
    const ocrFailures: { pageNumber: number; reason: string }[] = [];
    const formulasByPage = new Map<number, unknown[]>();

    for (const page of extracted) {
      if (!thin.includes(page)) {
        pages.push({ pageNumber: page.pageNumber, text: page.text });
        continue;
      }
      if (!this.ocr.available) {
        ocrFailures.push({ pageNumber: page.pageNumber, reason: `no OCR provider is configured (${this.ocr.name})` });
        pages.push({ pageNumber: page.pageNumber, text: page.text, fromOcr: false, ocrConfidence: null });
        continue;
      }
      try {
        const result = await this.ocr.recognise({ body: bytes, contentType: asset.mimeType, pageNumber: page.pageNumber, mathHint: true });
        // The formulas travel beside the text; the text carries placeholders so no later step
        // reads half-parsed mathematics as prose. Neither copy is the only one.
        formulasByPage.set(page.pageNumber, result.formulas);
        pages.push({
          pageNumber: page.pageNumber,
          text: withFormulaPlaceholders(result.text, result.formulas),
          fromOcr: true,
          ocrConfidence: result.confidence,
        });
      } catch (error) {
        const reason = error instanceof OcrUnavailableError ? error.message : `OCR failed: ${error instanceof Error ? error.message : 'unknown'}`;
        ocrFailures.push({ pageNumber: page.pageNumber, reason });
        pages.push({ pageNumber: page.pageNumber, text: page.text, fromOcr: false, ocrConfidence: null });
      }
    }

    // 3. segment and classify.
    await this.stage(job, 'segmenting');
    const blocks = segmentPages(pages);
    await this.stage(job, 'classifying');

    // 4. map to the syllabus. First the hierarchy the PDF prints, matched inside the uploaded subject;
    //    a block under no detected heading falls back to term matching against that subject's
    //    published sub-topics. Nothing here creates a node.
    // 4. map to the syllabus. First detect subject if not provided at upload
    await this.stage(job, 'tagging');
    if (!asset.subjectId) {
      const detectedSubject = await detectSubjectFromDocument({
        tenantId,
        db: this.db,
        ai: this.ai,
        pages,
        hints: { trackId: asset.trackId, subjectId: asset.subjectId },
      });
      if (detectedSubject) {
        await this.repo.updateAsset(tenantId, asset.id, {
          subjectId: detectedSubject.subjectId,
          trackId: detectedSubject.trackId,
        });
        asset.subjectId = detectedSubject.subjectId;
        asset.trackId = detectedSubject.trackId;
        this.logger.log(`Document subject automatically detected: "${detectedSubject.subjectName}" (Track: "${detectedSubject.trackName}")`);
      }
    }

    const allCandidates = await this.repo.syllabusCandidates(tenantId, { trackId: asset.trackId, subjectId: asset.subjectId });
    // Scoped to the subject (and track) the uploader named; without a hint, the whole organisation as before.
    const candidates = asset.subjectId || asset.trackId ? allCandidates.filter((c) => c.matchesUploadHint) : allCandidates;
    const hierarchy = await this.detectStructure(tenantId, asset, blocks, pages);
    // The model step may have re-cut the text at the heading lines it picked; everything after uses that cut.
    const mapped = hierarchy.segments.map((block, index) => {
      const fallback = mapToSubtopic({ text: block.text, title: block.title, candidates });
      const key = hierarchy.detection.blockPath[index] ?? null;
      const match = key ? hierarchy.matches.get(key) : undefined;
      const path = key ? hierarchy.detection.paths.find((p) => p.key === key) : undefined;
      if (!match || !path || !hierarchy.subject) return { block, mapping: fallback, path: null };
      return { block, mapping: mappingFromPath(match, fallback), path: { key: path.key, detected: path, match } };
    });

    // 5. read the questions out of the question blocks.
    await this.stage(job, 'normalizing');
    const proposals = new Map<number, ExtractedQuestion>();
    const provenances = new Map<number, Provenance>();
    // The text as extracted, before any model touched a block. It is what `raw_text` keeps, whatever happens next.
    const originalTexts = new Map<number, string>();
    const needsModel: number[] = [];
    for (const [index, item] of mapped.entries()) {
      originalTexts.set(index, item.block.text);
      const proposal = item.block.kind === 'question' ? extractQuestion(item.block.text) : null;
      if (proposal) proposals.set(index, proposal);
      provenances.set(index, EXTRACTED);
      // The rules first. A model is asked only where they could not read the block: it is ambiguous, or the question
      // has gaps or does not form a valid one. A merely middling confidence is not a reason to replace a clean
      // rule-based reading with a model's.
      const rulesFailed = item.block.kind === 'question' && (proposal === null || proposal.gaps.length > 0 || !proposal.shapeValid);
      if (this.ai.configured && (rulesFailed || item.block.kind === 'ambiguous')) needsModel.push(index);
    }

    // Bounded in both width and total, so one large book cannot turn into an unbounded number of paid requests.
    const modelBatch = needsModel.slice(0, MAX_MODEL_BLOCKS_PER_JOB);
    if (needsModel.length > modelBatch.length) {
      this.logger.warn(`job ${job.id}: ${needsModel.length - modelBatch.length} blocks were left to the rules and a reviewer (model cap of ${MAX_MODEL_BLOCKS_PER_JOB})`);
    }
    const understood = await mapWithConcurrency(modelBatch, MODEL_CONCURRENCY, (index) =>
      understandBlockWithAi({
        ai: this.ai,
        block: mapped[index]!.block,
        context: { subjectName: hierarchy.subject?.subjectName, topicName: mapped[index]!.path?.detected.topic?.name ?? undefined },
      }),
    );
    for (const [position, index] of modelBatch.entries()) {
      const understanding: AiUnderstanding | null = understood[position] ?? null;
      if (!understanding) continue;
      const applied = applyAiUnderstanding(mapped[index]!.block, understanding.value, proposals.get(index) ?? null);
      mapped[index]!.block = applied.block;
      if (applied.proposal) proposals.set(index, applied.proposal);
      else proposals.delete(index);
      provenances.set(
        index,
        withAi(EXTRACTED, {
          task: 'content_understanding',
          provider: understanding.provider,
          model: understanding.model,
          at: new Date().toISOString(),
          textDecision: applied.textDecision,
        }),
      );
    }

    // Everything above is pure. One transaction writes it all, so a reader never sees a job
    // half-way through a re-run.
    await this.db.transaction(async (tx) => {
      await this.repo.replacePages(
        tenantId,
        job.id,
        pages.map((page) => ({
          tenantId,
          jobId: job.id,
          assetId: asset.id,
          pageNumber: page.pageNumber,
          method: page.fromOcr ? ('ocr' as const) : ('text_layer' as const),
          textContent: page.text,
          ocrConfidence: page.fromOcr ? (page.ocrConfidence ?? null) : null,
        })),
        tx,
      );

      await this.repo.deleteOpenMachineTasks(tenantId, job.id, tx);

      const rows = await this.repo.replaceMachineBlocks(
        tenantId,
        job.id,
        mapped.map(({ block, mapping, path }, index) => {
          const ocrPage = pages.find((p) => p.pageNumber === block.sourcePage);
          const proposal = proposals.get(index) ?? null;
          const provenance = provenances.get(index) ?? EXTRACTED;
          return {
            tenantId,
            jobId: job.id,
            assetId: asset.id,
            sourcePage: block.sourcePage,
            kind: block.kind,
            format: block.format,
            title: block.title,
            // What the PDF said, untouched. `normalized_text` is what the rest of the system reads: the same words
            // unless a model's faithful tidy-up replaced them.
            rawText: originalTexts.get(index) ?? block.text,
            normalizedText: block.text,
            contentHash: block.contentHash,
            classificationConfidence: block.confidence,
            classifiedBy: provenance.ai ? ('model' as const) : ('rule' as const),
            subtopicId: mapping.subtopicId,
            taggingConfidence: mapping.confidence,
            sortOrder: block.sortOrder,
            // Everything the machine concluded, kept where a reviewer can see it and a re-run can
            // overwrite it. `content_blocks.content_json` existed for this.
            contentJson: {
              classification: { reason: block.reason, confidence: block.confidence },
              mapping: {
                reason: mapping.reason,
                confidence: mapping.confidence,
                alternatives: mapping.alternatives,
                proposedSubtopicName: mapping.proposedSubtopicName,
                hierarchy: path ? hierarchyNote(path.key, path.detected, path.match) : null,
              },
              source: { page: block.sourcePage, order: block.sortOrder, number: block.sourceNumber, assetId: asset.id },
              ocr: ocrPage?.fromOcr ? { confidence: ocrPage.ocrConfidence, formulas: formulasByPage.get(block.sourcePage) ?? [] } : null,
              question: proposal,
              provenance: path && path.match.resolvedSubtopicId ? withInferred(provenance, 'sub-topic taken from the headings printed above the block') : provenance,
            },
            status: 'extracted' as const,
          };
        }),
        tx,
      );
      if (hierarchy.subject) await this.writeSuggestions(job, hierarchy.subject, hierarchy.detection, rows, tx);
      return rows;
    });

    const summary = hierarchySummary(hierarchy, mapped.map((m) => m.path));
    await this.repo.updateJob(tenantId, job.id, { hierarchy: summary });

    // 6. match solutions to questions, by number, proximity and reading order, and record the
    //    match on both blocks so publication can attach the solution without matching again.
    await this.stage(job, 'matching');
    // Every block of this job, not only the ones this run just wrote: after a retry the reviewer's
    // blocks are still part of the document, and a solution has to be able to find the question a
    // person edited.
    const all = await this.repo.blocksOfJob(tenantId, job.id);
    // The blocks still in play. A published, rejected or superseded block has been settled by a
    // person, so nothing below re-decides it, re-opens a task against it, or — the one that would
    // really hurt — resets a published block's status.
    const inPlay = all.filter((row) => row.status !== 'published' && row.status !== 'rejected' && row.status !== 'superseded');
    // One working copy of each block's content_json, so the three steps that add to it
    // (solution matching, the gate record, the auto-approval decision) build on each other instead
    // of each overwriting the last from a stale row.
    const notes = new Map<string, Record<string, unknown>>(inPlay.map((row) => [row.id, { ...jsonOf(row) }]));
    const matches = this.matchSolutionBlocks(inPlay);
    await this.recordSolutionMatches(tenantId, inPlay, matches, notes, params);

    // 7. near-duplicate questions, using the configured trigram threshold.
    await this.stage(job, 'deduplicating');
    const duplicates = await this.findDuplicates(tenantId, inPlay, params);

    // 8. review tasks for everything a person has to look at.
    const suggestionOf = await this.suggestions.linksOfJob(tenantId, job.id);
    await this.raiseTasks(job, asset, { blocks: inPlay, notes, matches, duplicates, ocrFailures, params, suggestionOf, hierarchy: summary });

    // 9. drafts of learning material, written for a person to approve with the rest of the document. Nothing is
    //    published here, and nothing a model writes is ever presented as the document's own.
    const draftOutcome = await this.drafts.generate(job, asset, params);
    //    Practice questions at levels 1-4, written from the document's own theory. They are previewed like everything
    //    else, labelled as AI-written, and their answers stay unverified until a person checks them.
    const questionDraftOutcome = await this.questionDrafts.generate(job, asset, params);

    // Publication is the administrator's single, final act on the whole document (`DocumentApprovalService`). The
    // pipeline's work ends with the document prepared and waiting.
    const finalBlocks = await this.repo.blocksOfJob(tenantId, job.id);
    const extractedBlocks = finalBlocks.filter((b) => readProvenance(b.contentJson).origin !== 'ai_generated');
    const counts = tally(extractedBlocks);

    const updatedSummary = {
      ...summary,
      topicsDetected: (summary as Record<string, unknown>).paths ?? 0,
      subtopicsDetected: (summary as Record<string, unknown>).blocksFiledToExisting ?? 0,
      theoryBlocks: counts.theory,
      questions: counts.question,
      learningDrafts: draftOutcome.drafted,
      learningDraftsNote: draftOutcome.note,
      questionDrafts: questionDraftOutcome.drafted,
      questionDraftsNote: questionDraftOutcome.note,
    };

    await this.repo.updateJob(tenantId, job.id, {
      status: 'awaiting_review',
      progressPct: stageProgress('awaiting_review'),
      pagesTotal: pages.length,
      pagesOcr: pages.filter((p) => p.fromOcr).length,
      blocksTheory: counts.theory,
      blocksQuestion: counts.question,
      blocksSolution: counts.solution,
      blocksAmbiguous: counts.ambiguous,
      hierarchy: updatedSummary,
    });

    await this.audit.record({
      tenantId,
      action: 'ingestion_job.processed',
      entityType: 'ingestion_job',
      entityId: job.id,
      after: {
        pages: pages.length,
        pagesOcr: pages.filter((p) => p.fromOcr).length,
        blocks: counts,
        questionProposals: proposals.size,
        blocksAwaitingReview: inPlay.length,
        solutionMatches: matches.filter((m) => m.questionBlockId !== null).length,
        duplicateWarnings: duplicates.length,
        ocrFailures: ocrFailures.length,
        attempt: job.attemptCount + 1,
      },
    });
  }

  // ---------------------------------------------------------------- pieces of the above

  private async readAsset(asset: ContentAssetRow): Promise<Buffer> {
    try {
      return await this.storage.get(asset.storageKey);
    } catch (error) {
      throw new PipelineError('asset_unreadable', `the stored PDF could not be read back: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /**
   * Solution blocks paired with question blocks, using the persisted rows.
   *
   * Everything it needs is read back out of `content_json`, which the transaction above wrote: the
   * question the extractor read and the source number the segmenter saw. Pairing the returned rows
   * with the in-memory segments by position or by text would both be wrong after a re-run, where
   * blocks a reviewer has touched are kept and the returned set is only the machine's.
   */
  private matchSolutionBlocks(rows: BlockForMatching[]): SolutionMatch[] {
    const questionCandidates: QuestionCandidate[] = rows
      .filter((r) => r.kind === 'question')
      .map((r) => {
        const proposal = proposalOf(r);
        return {
          blockId: r.id,
          sourceNumber: sourceNumberOf(r),
          sourcePage: r.sourcePage ?? 1,
          sortOrder: r.sortOrder,
          stem: proposal?.stem ?? r.rawText,
          correctOptionKeys: proposal?.options.filter((o) => o.isCorrect).map((o) => o.key) ?? [],
          correctNumeric: proposal?.numericAnswer?.value ?? null,
        };
      });

    const solutionCandidates: SolutionCandidate[] = rows
      .filter((r) => r.kind === 'solution')
      .map((r) => ({ blockId: r.id, sourceNumber: sourceNumberOf(r), sourcePage: r.sourcePage ?? 1, sortOrder: r.sortOrder, text: r.rawText }));

    return matchSolutions(solutionCandidates, questionCandidates);
  }

  /**
   * Writes each confident match onto both blocks.
   *
   * This is what makes a solution publishable: `ReviewService.publish` reads
   * `content_json.solution` off the question block and sets it as the official solution, so without
   * this step the matching would be computed, reported on a review task, and then thrown away.
   *
   * A match below `ingestion.confidence.solution_min`, or one whose stated answer contradicts the
   * question's key, is recorded but marked unconfirmed — the question's `solution_linkage` gate
   * then blocks publication until a person settles it. A guess is never quietly promoted to an
   * official solution.
   */
  private async recordSolutionMatches(
    tenantId: string,
    rows: BlockForMatching[],
    matches: readonly SolutionMatch[],
    notes: Map<string, Record<string, unknown>>,
    params: IngestionParams,
  ): Promise<void> {
    const textOf = new Map(rows.map((r) => [r.id, r.rawText]));
    for (const match of matches) {
      const solutionNote = notes.get(match.solutionBlockId);
      if (!solutionNote) continue;
      const confirmed = match.questionBlockId !== null && !match.answerConflict && match.confidence >= params.ingestion.confidence.solution_min;
      const note = {
        blockId: match.solutionBlockId,
        questionBlockId: match.questionBlockId,
        confidence: match.confidence,
        reason: match.reason,
        answerConflict: match.answerConflict,
        confirmed,
      };

      solutionNote.solutionMatch = note;
      await this.repo.updateBlock(tenantId, match.solutionBlockId, { contentJson: solutionNote });

      if (match.questionBlockId) {
        const questionNote = notes.get(match.questionBlockId);
        if (!questionNote) continue;
        const solutionText = textOf.get(match.solutionBlockId) ?? '';
        questionNote.solution = { ...note, text: solutionText };

        // A question printed without its answer takes it from the solution matched to it — only for a match the
        // evidence supports, and never over an answer the question already has (printed, or a reviewer's).
        const current = questionNote.question as ExtractedQuestion | null | undefined;
        if (confirmed && current) {
          const filled = applySolutionAnswer(current, statedAnswerOf(solutionText), match.confidence);
          if (filled) {
            questionNote.question = filled;
            questionNote.provenance = withInferred(readProvenance(questionNote), 'answer taken from the matched solution');
          }
        }
        await this.repo.updateBlock(tenantId, match.questionBlockId, { contentJson: questionNote });
      }
    }
  }

  /** Near-duplicate warnings for every question proposal, against the existing bank. */
  private async findDuplicates(
    tenantId: string,
    rows: { id: string; kind: string; contentJson: unknown }[],
    params: IngestionParams,
  ): Promise<{ blockId: string; questionId: string; similarity: number; stem: string }[]> {
    const out: { blockId: string; questionId: string; similarity: number; stem: string }[] = [];
    for (const row of rows) {
      if (row.kind !== 'question') continue;
      const proposal = (row.contentJson as { question?: ExtractedQuestion | null } | null)?.question ?? null;
      const stem = proposal?.stem;
      if (!stem || stem.trim().length === 0) continue;
      const hits = await this.repo.nearDuplicateQuestions(tenantId, stem, params.near_duplicate.trigram_similarity, null);
      for (const hit of hits) out.push({ blockId: row.id, ...hit });
    }
    return out;
  }

  /**
   * One review task per thing a person has to decide, then the auto-approval verdict for each
   * block.
   *
   * Nothing here deletes and nothing here publishes: a task is how the pipeline hands a judgement
   * call to a human, and the verdict below only decides whether a block starts at `approved` or at
   * `needs_review`. The order matters — the tasks are opened first, because "no open task names
   * this block" is one of the conditions auto-approval is allowed to rely on.
   */
  private async raiseTasks(
    job: IngestionJobRow,
    asset: ContentAssetRow,
    input: {
      blocks: BlockForMatching[];
      notes: Map<string, Record<string, unknown>>;
      matches: readonly SolutionMatch[];
      duplicates: { blockId: string; questionId: string; similarity: number; stem: string }[];
      ocrFailures: { pageNumber: number; reason: string }[];
      params: IngestionParams;
      /** Block id → the syllabus suggestion it is waiting on. */
      suggestionOf: Map<string, string>;
      hierarchy: Record<string, unknown>;
    },
  ): Promise<void> {
    const tenantId = job.tenantId;
    const { confidence } = input.params.ingestion;
    const open = (draft: ReviewTaskDraft): Promise<unknown> => this.repo.openMachineTask(tenantId, job.id, draft);

    // A page whose text layer was too thin and which could not be read another way. It is recorded
    // rather than dropped: content silently missing from a textbook is the failure mode that would
    // be hardest to notice later.
    for (const page of input.ocrFailures) {
      await open({
        kind: 'theory_review',
        priority: 2,
        reason: `page ${page.pageNumber} has too little text to use and could not be read another way: ${page.reason}`,
        suggestion: { stage: 'ocr', pageNumber: page.pageNumber, assetId: asset.id },
      });
    }

    // The PDF did not state its own chapter/topic/sub-topic structure. Nothing is invented from that; a
    // person is told, once, for the whole upload.
    if (input.hierarchy.status === 'needs_review') {
      await open({
        kind: 'theory_review',
        priority: 2,
        reason: `Hierarchy needs review: ${String((input.hierarchy.notes as string[] | undefined)?.[0] ?? 'the PDF does not state its chapter/topic/sub-topic structure')}`,
        suggestion: { stage: 'hierarchy', ...input.hierarchy },
      });
    }

    for (const row of input.blocks) {
      const note = input.notes.get(row.id) ?? {};
      const mapping = note.mapping as
        | { proposedSubtopicName?: string | null; alternatives?: unknown; hierarchy?: { chapter: string | null; topic: string | null; subtopic: string | null } | null }
        | undefined;
      const waitingOn = input.suggestionOf.get(row.id) ?? null;

      if (row.kind === 'ambiguous') {
        await open({
          kind: 'block_classification',
          priority: 2,
          contentBlockId: row.id,
          reason: 'the classifier could not tell what this block is',
          suggestion: { confidence: row.classificationConfidence },
        });
      } else if ((row.classificationConfidence ?? 0) < confidence.classification_min) {
        await open({
          kind: 'block_classification',
          priority: 3,
          contentBlockId: row.id,
          reason: `classified as ${row.kind} with confidence ${row.classificationConfidence ?? 0}, below the ${confidence.classification_min} floor`,
          suggestion: { kind: row.kind, confidence: row.classificationConfidence },
        });
      }

      // No sub-topic fitted. This is where an AI proposal stops: a *name* on a task for a person to
      // accept or ignore. It is never a syllabus insert.
      //
      // Not a `content_gap` task, which the schema reserves for a sub-topic that exists and is
      // short of questions — it requires `subtopic_id`, and the whole point here is that there is
      // no sub-topic. The task is a review of this block, so it is filed as one.
      if (row.subtopicId === null && waitingOn !== null) {
        const h = mapping?.hierarchy;
        const pathText = [h?.chapter, h?.topic, h?.subtopic].map((n) => n ?? '(unresolved)').join(' › ');
        await open({
          kind: row.kind === 'question' ? 'question_review' : 'theory_review',
          priority: 2,
          contentBlockId: row.id,
          reason: `waiting for approval of the suggested syllabus: ${pathText}`,
          suggestion: { unmapped: true, syllabusSuggestionId: waitingOn, proposedPath: h ?? null },
        });
      } else if (row.subtopicId === null) {
        await open({
          kind: row.kind === 'question' ? 'question_review' : 'theory_review',
          priority: 2,
          contentBlockId: row.id,
          reason: mapping?.proposedSubtopicName
            ? `no existing sub-topic fits; the content looks like "${mapping.proposedSubtopicName}"`
            : 'no existing sub-topic fits this content',
          suggestion: { unmapped: true, proposedSubtopicName: mapping?.proposedSubtopicName ?? null },
        });
      } else if ((row.taggingConfidence ?? 0) < confidence.mapping_min) {
        await open({
          kind: 'theory_review',
          priority: 3,
          contentBlockId: row.id,
          subtopicId: row.subtopicId,
          reason: `mapped to this sub-topic with confidence ${row.taggingConfidence ?? 0}, below the ${confidence.mapping_min} floor`,
          suggestion: { alternatives: mapping?.alternatives ?? [] },
        });
      }

      const proposal = currentProposal(note, row);
      if (row.kind === 'question' && proposal && (!proposal.shapeValid || proposal.gaps.length > 0 || proposal.confidence < confidence.question_min)) {
        await open({
          kind: 'question_review',
          // An unreadable question is priority 1: it is the case where publishing the machine's
          // guess would put something wrong in front of a student.
          priority: proposal.shapeValid ? 3 : 1,
          contentBlockId: row.id,
          subtopicId: row.subtopicId,
          reason:
            proposal.gaps.length > 0
              ? `the question is incomplete: ${proposal.gaps.join('; ')}`
              : `read with confidence ${proposal.confidence}, below the ${confidence.question_min} floor`,
          suggestion: { gaps: proposal.gaps, shapeErrors: proposal.shapeErrors, confidence: proposal.confidence, type: proposal.type },
        });
      }
    }

    for (const match of input.matches) {
      if (match.answerConflict) {
        await open({
          kind: 'solution_match',
          priority: 1,
          contentBlockId: match.solutionBlockId,
          reason: "the solution's own stated answer contradicts the question's answer key",
          suggestion: { questionBlockId: match.questionBlockId, confidence: match.confidence, reason: match.reason, answerConflict: true },
        });
      } else if (match.questionBlockId === null || match.confidence < confidence.solution_min) {
        await open({
          kind: 'solution_match',
          priority: 2,
          contentBlockId: match.solutionBlockId,
          reason:
            match.questionBlockId === null
              ? 'this solution could not be matched to a question'
              : `matched with confidence ${match.confidence}, below the ${confidence.solution_min} floor`,
          suggestion: { questionBlockId: match.questionBlockId, confidence: match.confidence, reason: match.reason, alternatives: match.alternatives },
        });
      }
    }

    // A near-duplicate is a warning, never a deletion: the source document is evidence and which of
    // two similar questions to keep is a judgement.
    for (const duplicate of input.duplicates) {
      await open({
        kind: 'duplicate_candidate',
        priority: 2,
        contentBlockId: duplicate.blockId,
        duplicateOfQuestionId: duplicate.questionId,
        reason: `this looks like an existing question (trigram similarity ${duplicate.similarity.toFixed(3)})`,
        suggestion: { similarity: duplicate.similarity, existingStem: duplicate.stem.slice(0, 400) },
      });
    }

    await this.decideEach(job, input.blocks, input.notes, input.params);
  }

  /**
   * The auto-approval verdict for each block, recorded either way.
   *
   * The gates a block is judged against are the ones it would actually be published through: a
   * question block gets `checkQuestionGates` — the same call `ReviewService.publish` makes —
   * because judging it as theory would fail it on `block_kind` and quietly make every question
   * ineligible. A **solution** or **ambiguous** block is never auto-approved: neither is publishable
   * on its own, and an ambiguous one exists precisely because the machine does not know what it is.
   *
   * Recording the verdict on a block that is *not* auto-approved matters as much as on one that is.
   * It is what lets a reviewer see why something is waiting for them rather than guessing.
   */
  private async decideEach(
    job: IngestionJobRow,
    blocks: BlockForMatching[],
    notes: Map<string, Record<string, unknown>>,
    params: IngestionParams,
  ): Promise<void> {
    const tenantId = job.tenantId;
    const tracksBySubtopic = await this.repo.tracksOfSubtopics(
      tenantId,
      blocks.map((b) => b.subtopicId).filter((id): id is string => id !== null),
    );
    for (const row of blocks) {
      const note = notes.get(row.id) ?? {};
      // The question as it stands now — after a matched solution may have supplied its answer — not as first read.
      const proposal = currentProposal(note, row);
      const fromOcr = Boolean(note.ocr);
      const aiAssisted = isAiTouched(note);
      const openTasks = await this.repo.openTaskCount(tenantId, { blockId: row.id });
      const solution = note.solution as { confirmed?: boolean } | undefined;
      const difficultyLabel = proposal ? (proposal.difficultyLabel ?? sourceDifficultyToLabel(proposal.sourceDifficulty)) : null;
      // One query for every block's track, taken before the loop: see tracksOfSubtopics.
      const track: TrackIdentity = row.subtopicId ? (tracksBySubtopic.get(row.subtopicId) ?? UNKNOWN_TRACK) : UNKNOWN_TRACK;

      const gates =
        row.kind === 'question' && proposal
          ? checkQuestionGates(
              {
                tenantMatches: true,
                stem: proposal.stem,
                type: proposal.type,
                options: proposal.options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })),
                numericAnswer: proposal.numericAnswer,
                matrixAnswer: null,
                subtopicId: row.subtopicId,
                difficultyLabel,
                expectedTimeSeconds: proposal.expectedTimeSeconds ?? null,
                referencesDiagram: referencesDiagram(proposal.stem),
                hasDiagramAsset: false,
                diagramAcknowledged: proposal.diagramAcknowledged === true,
                answerUnverified: proposal.answerSource === 'ai_unverified',
                fromOcr,
                reviewed: false,
                lowestConfidence: Math.min(row.classificationConfidence ?? 0, row.taggingConfidence ?? 0, proposal.confidence),
                solutionPending: solution !== undefined && solution.confirmed !== true,
                openCriticalTasks: openTasks,
              },
              params,
            )
          : checkBlockGates(
              {
                tenantMatches: true,
                kind: row.kind,
                text: row.rawText,
                subtopicId: row.subtopicId,
                fromOcr,
                reviewed: false,
                lowestConfidence: Math.min(row.classificationConfidence ?? 0, row.taggingConfidence ?? 0),
                openCriticalTasks: openTasks,
              },
              params,
            );

      const eligibleKind = row.kind === 'theory' || row.kind === 'question';
      const decision = decideAutoApproval(
        {
          entityId: row.id,
          confidences: [row.classificationConfidence ?? 0, row.taggingConfidence ?? 0, ...(proposal ? [proposal.confidence] : [])],
          fromOcr,
          aiAssisted,
          difficultyLabel,
          track,
          gatesPass: eligibleKind && gates.ok,
          openCriticalTasks: openTasks,
        },
        params,
      );

      note.gates = { ok: gates.ok, failures: gates.failures };
      // "Approved" here means the rules found nothing to hold the block back — it is the machine's reading of how
      // ready the block is, shown to the reviewer. It publishes nothing: only the administrator's approval of the
      // document does (`DocumentApprovalService`). `sampledForAudit` marks the share of ready blocks the sampling
      // rule picks out for a closer look in the preview; it is information, not a task that stops the approval.
      note.autoApproval = decision;
      // The verdict is recorded on every block, because a reviewer wants to know what the machine
      // made of it. The **status** is only the machine's to set while the machine still owns the
      // block: once a person has reviewed it, a re-run that moved an approved block back to
      // `needs_review` would be the pipeline quietly undoing a decision someone made.
      const machineOwned = row.reviewedBy === null;
      await this.repo.updateBlock(tenantId, row.id, {
        ...(machineOwned ? { status: decision.autoApprove ? ('approved' as const) : ('needs_review' as const) } : {}),
        contentJson: note,
      });
    }
  }


  // ---------------------------------------------------------------- syllabus hierarchy

  /**
   * The hierarchy the PDF prints, matched against the uploaded subject's tree.
   *
   * Deterministic first. A model is asked only when the document has no numbered or "Chapter N"
   * structure at all, only to choose among the document's own heading lines, and only when a provider
   * is configured; whatever it chooses is re-grounded against the PDF text. A failure of that step is
   * not a failure of the job — the upload simply needs its hierarchy reviewed.
   */
  private async detectStructure(tenantId: string, asset: ContentAssetRow, segments: SegmentedBlock[], pages: readonly PageText[]): Promise<StructureResult> {
    const toBlocks = (from: readonly SegmentedBlock[]): HierarchyBlock[] =>
      from.map((b, index) => ({ index, kind: b.kind, format: b.format, title: b.title, text: b.text, page: b.sourcePage }));
    let blocks = toBlocks(segments);
    const subject = asset.subjectId ? ((await this.suggestions.subjectContext(tenantId, asset.subjectId)) ?? null) : null;
    let detection = detectHierarchy(blocks);

    if (subject && !detection.sufficient && this.ai.configured) {
      const candidates = headingCandidates(blocks);
      if (candidates.length >= 2) {
        try {
          const reply = await this.ai.generateJson(
            { task: 'syllabus_structure', prompt: buildHeadingPrompt(subject.subjectName, candidates), temperature: 0, maxOutputTokens: 2048 },
            (text) => parseHeadingReply(text, candidates.length),
          );
          const documentText = pages.map((p) => p.text).join('\n');
          let fromModel = detectionFromModel(blocks, candidates, reply.value, documentText);
          // A chosen heading inside a block of text: cut the text at the chosen lines (exact PDF lines,
          // nothing else) so each section's text is filed under its own heading, then read it again.
          const chosen = reply.value.map((c) => candidates[c.line - 1]).filter((c): c is (typeof candidates)[number] => c !== undefined);
          if (fromModel.sufficient && chosen.some((c) => c.lineIndex > 0)) {
            const resegmented = segmentPages(pages, { boundaries: new Set(chosen.map((c) => c.line)) });
            const reBlocks = toBlocks(resegmented);
            const reCandidates = headingCandidates(reBlocks);
            const byLine = new Map(reCandidates.map((c, i) => [`${c.page}|${c.line}`, i + 1]));
            const reChoices = reply.value.flatMap((c) => {
              const was = candidates[c.line - 1];
              const now = was ? byLine.get(`${was.page}|${was.line}`) : undefined;
              return now ? [{ line: now, level: c.level }] : [];
            });
            const reDetection = detectionFromModel(reBlocks, reCandidates, reChoices, documentText);
            if (reDetection.sufficient) {
              fromModel = reDetection;
              blocks = reBlocks;
              segments = resegmented;
            }
          }
          if (fromModel.sufficient) detection = fromModel;
          else detection = { ...detection, notes: [...detection.notes, 'a model was asked to pick headings and found no usable structure'] };
        } catch (error) {
          this.logger.warn(`hierarchy model step skipped for asset ${asset.id}: ${error instanceof Error ? error.message : 'unknown'}`);
          detection = { ...detection, notes: [...detection.notes, 'the model step to pick headings was unavailable'] };
        }
      }
    }

    const matches = new Map<string, PathMatch>();
    if (subject) {
      const tree = await this.suggestions.subjectTree(tenantId, subject.subjectId);
      for (const path of detection.paths) matches.set(path.key, matchPath(path, tree));
    }
    return { subject, detection, matches, segments };
  }

  /**
   * One suggestion per detected path that needs a node the subject does not have (or has only as a
   * draft), shared with any other upload already proposing the same path, and the blocks under it
   * linked to it. A path a person has rejected for this subject is not proposed again.
   */
  private async writeSuggestions(
    job: IngestionJobRow,
    subject: SubjectContext,
    detection: HierarchyDetection,
    rows: readonly ContentBlockRow[],
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  ): Promise<void> {
    const tenantId = job.tenantId;
    const waiting = new Map<string, { note: HierarchyNote; blockIds: string[] }>();
    for (const row of rows) {
      const note = (jsonOf(row).mapping as { hierarchy?: HierarchyNote | null } | undefined)?.hierarchy;
      if (!note?.needsApproval) continue;
      const entry = waiting.get(note.key) ?? { note, blockIds: [] };
      entry.blockIds.push(row.id);
      waiting.set(note.key, entry);
    }

    for (const { note, blockIds } of waiting.values()) {
      const keys = { chapterKey: note.chapterKey, topicKey: note.topicKey, subtopicKey: note.subtopicKey };
      const rejected = await this.suggestions.findRejected(tenantId, subject.subjectId, keys, tx);
      if (rejected) {
        await this.suggestions.stamp(tenantId, null, blockIds, tx, { needsApproval: false, rejectedSuggestionId: rejected.id });
        continue;
      }
      const path = detection.paths.find((p) => p.key === note.key);
      const fields = {
        chapterName: note.chapter,
        topicName: note.topic,
        subtopicName: note.subtopic,
        existingChapterId: note.existingChapterId,
        existingTopicId: note.existingTopicId,
        existingSubtopicId: note.existingSubtopicId,
        confidence: note.confidence,
        evidence: { method: detection.method, detected: path ? evidenceOf(path) : null, match: note.match, notes: detection.notes.slice(0, 5) },
        mappingReason: note.reason.slice(0, 2000),
      };
      let suggestion = await this.suggestions.findPending(tenantId, subject.subjectId, keys, tx);
      if (suggestion) {
        // The tree may have changed since it was proposed (an approval elsewhere created a level), so
        // its view of what exists is refreshed; its names and identity are not.
        suggestion = await this.suggestions.update(
          tenantId,
          suggestion.id,
          { existingChapterId: fields.existingChapterId, existingTopicId: fields.existingTopicId, existingSubtopicId: fields.existingSubtopicId, confidence: fields.confidence, mappingReason: fields.mappingReason },
          tx,
        );
      } else {
        suggestion = await this.suggestions.insert({ tenantId, jobId: job.id, trackId: subject.trackId, subjectId: subject.subjectId, ...keys, ...fields, status: 'pending' }, tx);
      }
      await this.suggestions.link(tenantId, suggestion.id, blockIds, tx);
      await this.suggestions.stamp(tenantId, suggestion.id, blockIds, tx);
    }
    await this.suggestions.deleteOrphanedPending(tenantId, job.id, tx);
  }

  // ---------------------------------------------------------------- bookkeeping

  private async stage(job: IngestionJobRow, status: JobStatus): Promise<void> {
    await this.repo.updateJob(job.tenantId, job.id, { status, progressPct: stageProgress(status) });
  }

  private async fail(job: IngestionJobRow, code: string, message: string): Promise<void> {
    await this.repo.updateJob(job.tenantId, job.id, {
      status: 'failed',
      errorCode: code.slice(0, 100),
      errorMessage: message.slice(0, 2000),
      finishedAt: sql`now()`,
    });
    await this.audit.record({
      tenantId: job.tenantId,
      action: 'ingestion_job.failed',
      entityType: 'ingestion_job',
      entityId: job.id,
      after: { code, message: message.slice(0, 500), attempt: job.attemptCount + 1 },
    });
  }

  private async params(tenantId: string): Promise<IngestionParams> {
    const active = await this.engineConfig.rawActiveParams(tenantId);
    const parsed = parseIngestionParams(active.params);
    if (!parsed.ok) {
      throw new PipelineError(
        'engine_config_invalid',
        `engine configuration v${active.version} has no usable ingestion settings: ${parsed.issues.map((i) => i.field).join(', ')}`,
      );
    }
    return parsed.value;
  }
}

/** How many blocks one job may send to a model, and how many requests run at once. Both bound cost and time. */
const MAX_MODEL_BLOCKS_PER_JOB = 150;
const MODEL_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` in flight, keeping the results in the order of the items. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A failure with a stable code, so `ingestion_jobs.error_code` is not a message string. */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * Where each stage sits, as a percentage, so a caller polling the job sees it move.
 *
 * The keys are `ingestion_jobs.status` values, which migration 0003 fixed. The requirements list
 * the stages in slightly different words — "uploaded", "validating", "mapping", "extracting
 * questions", "embedding", "ready_for_review" — and this is the mapping onto the statuses the
 * database already has, rather than a migration to rename them.
 */
const STAGES: Partial<Record<JobStatus, number>> = {
  queued: 0,
  extracting: 15,
  ocr: 30,
  segmenting: 40,
  classifying: 50,
  tagging: 60,
  normalizing: 70,
  matching: 80,
  deduplicating: 90,
  awaiting_review: 95,
  publishing: 98,
  published: 100,
};

export function stageProgress(status: JobStatus): number {
  return STAGES[status] ?? 0;
}

function tally(blocks: readonly { kind: string }[]): { theory: number; question: number; solution: number; ambiguous: number } {
  return {
    theory: blocks.filter((b) => b.kind === 'theory').length,
    question: blocks.filter((b) => b.kind === 'question').length,
    solution: blocks.filter((b) => b.kind === 'solution').length,
    ambiguous: blocks.filter((b) => b.kind === 'ambiguous').length,
  };
}

/**
 * The part of a persisted block the later stages read.
 *
 * They work from the rows the database returned rather than from the segments in memory, because
 * after a re-run those two sets are not the same: blocks a reviewer has touched are kept and are
 * not in the machine's output.
 */
type BlockForMatching = Pick<
  ContentBlockRow,
  | 'id'
  | 'kind'
  | 'rawText'
  | 'sourcePage'
  | 'sortOrder'
  | 'subtopicId'
  | 'classificationConfidence'
  | 'taggingConfidence'
  | 'contentJson'
  | 'reviewedBy'
>;

/** A block's `content_json` as a plain object, whatever the column actually holds. */
function jsonOf(row: { contentJson: unknown }): Record<string, unknown> {
  return row.contentJson !== null && typeof row.contentJson === 'object' ? (row.contentJson as Record<string, unknown>) : {};
}

/**
 * The question proposal as it stands in the working copy of a block's notes, falling back to the stored row.
 * The two differ once a matched solution has supplied an answer the question was printed without.
 */
function currentProposal(note: Record<string, unknown>, row: { contentJson: unknown }): ExtractedQuestion | null {
  const fromNote = note.question;
  if (fromNote !== null && typeof fromNote === 'object') return fromNote as ExtractedQuestion;
  return proposalOf(row);
}

/** The question the extractor read out of a block, from the row rather than from memory. */
function proposalOf(row: { contentJson: unknown }): ExtractedQuestion | null {
  const question = jsonOf(row).question;
  return question !== null && typeof question === 'object' ? (question as ExtractedQuestion) : null;
}

/** The printed number the segmenter saw on a block ("7", "Q7", "Solution 7"), when there was one. */
function sourceNumberOf(row: { contentJson: unknown }): string | null {
  const source = jsonOf(row).source as { number?: unknown } | undefined;
  return typeof source?.number === 'string' ? source.number : null;
}

// ---------------------------------------------------------------- syllabus hierarchy helpers

interface StructureResult {
  /** The segmented blocks everything after detection uses (re-cut at model-picked headings, if any). */
  segments: SegmentedBlock[];
  subject: SubjectContext | null;
  detection: HierarchyDetection;
  matches: Map<string, PathMatch>;
}

/** What a block records about the path it sits under, in `content_json.mapping.hierarchy`. */
interface HierarchyNote {
  key: string;
  chapter: string | null;
  topic: string | null;
  subtopic: string | null;
  chapterKey: string;
  topicKey: string;
  subtopicKey: string;
  existingChapterId: string | null;
  existingTopicId: string | null;
  existingSubtopicId: string | null;
  /** True when content cannot be filed until a person approves the path. */
  needsApproval: boolean;
  confidence: number;
  reason: string;
  match: Record<string, unknown>;
}

function hierarchyNote(key: string, path: DetectedPath, match: PathMatch): HierarchyNote {
  const level = (l: PathMatch['chapter']) => ({ how: l.how, score: l.score, existingName: l.existingName, existingStatus: l.existingStatus, closest: l.closest });
  return {
    key,
    chapter: path.chapter?.name ?? null,
    topic: path.topic?.name ?? null,
    subtopic: path.subtopic?.name ?? null,
    chapterKey: path.chapter ? normalizeName(path.chapter.name) : '',
    topicKey: path.topic ? normalizeName(path.topic.name) : '',
    subtopicKey: path.subtopic ? normalizeName(path.subtopic.name) : '',
    existingChapterId: match.chapter.existingId,
    existingTopicId: match.topic.existingId,
    existingSubtopicId: match.subtopic.existingId,
    needsApproval: match.resolvedSubtopicId === null,
    confidence: match.confidence,
    reason: match.reason,
    match: { chapter: level(match.chapter), topic: level(match.topic), subtopic: level(match.subtopic) },
  };
}

/** Heading lines and pages only — never block bodies. */
function evidenceOf(path: DetectedPath): Record<string, unknown> {
  const level = (l: DetectedPath['chapter']) => (l ? { heading: l.evidence, number: l.number, page: l.page, confidence: l.confidence, method: l.method } : null);
  return { chapter: level(path.chapter), topic: level(path.topic), subtopic: level(path.subtopic), blocks: path.blockIndexes.length };
}

/**
 * A block under a detected path. A fully existing, published path files it directly; otherwise it is
 * left unmapped to wait for the suggestion, and the term-matching result is kept only as alternatives
 * a reviewer can pick from — never as the mapping, which would quietly bypass the approval.
 */
function mappingFromPath(match: PathMatch, fallback: MappingResult): MappingResult {
  const alternatives = [
    ...(fallback.subtopicId ? [{ subtopicId: fallback.subtopicId, score: fallback.confidence }] : []),
    ...fallback.alternatives,
  ].filter((a) => a.subtopicId !== match.resolvedSubtopicId);
  if (match.resolvedSubtopicId) {
    return { subtopicId: match.resolvedSubtopicId, confidence: match.confidence, reason: `filed by the PDF's own headings: ${match.reason}`, alternatives, proposedSubtopicName: null };
  }
  return { subtopicId: null, confidence: match.confidence, reason: `needs the suggested syllabus to be approved: ${match.reason}`, alternatives, proposedSubtopicName: null };
}

/** `ingestion_jobs.hierarchy`: what detection concluded for the whole upload. */
function hierarchySummary(result: StructureResult, paths: readonly ({ key: string; match: PathMatch } | null)[]): Record<string, unknown> {
  const placed = paths.filter((p): p is { key: string; match: PathMatch } => p !== null);
  const status = !result.subject ? 'not_applicable' : !result.detection.sufficient ? 'needs_review' : 'detected';
  const notes = !result.subject
    ? ['the upload named no subject, so the PDF\'s hierarchy could not be matched to a syllabus; content is mapped to existing sub-topics only']
    : result.detection.notes;
  return {
    status,
    method: result.detection.method,
    subjectId: result.subject?.subjectId ?? null,
    headings: result.detection.headings.length,
    paths: result.detection.paths.length,
    blocksOnDetectedPaths: placed.length,
    blocksFiledToExisting: placed.filter((p) => p.match.resolvedSubtopicId !== null).length,
    blocksAwaitingApproval: placed.filter((p) => p.match.resolvedSubtopicId === null).length,
    notes: notes.slice(0, 8),
  };
}
