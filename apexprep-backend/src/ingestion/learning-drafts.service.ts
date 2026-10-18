import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE, type Database } from '../database/database.module';
import { tracks, type ContentAssetRow, type ContentBlockRow, type IngestionJobRow } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { chunkBlocks } from '../explanations/chunking';
import { parseExplanationParams } from '../explanations/explanation-params';
import { audienceFor } from '../learning-ai/audience';
import { buildNotesPrompt, NOTES_PROMPT_VERSION, parseNotesReply } from '../learning-ai/notes/notes.prompt';
import { validateNotes } from '../learning-ai/notes/notes.validation';
import { packBatches } from '../learning-ai/source';
import { draftOf, renderNotesText, type RevisionNotesDraft } from './learning-drafts';
import type { IngestionParams } from './ingestion-params';
import { IngestionRepository } from './ingestion.repository';
import { readProvenance, setProvenance, withAi, EXTRACTED } from './provenance';
import { isFragment } from './readiness';
import { hashText } from './segmentation';

/** Less than this much theory in a group is not enough to summarise: notes would repeat it or invent around it. */
const MIN_SOURCE_CHARS = 600;
/** How many groups of a document are drafted, so one very large book cannot become an unbounded number of requests. */
const MAX_DRAFTS_PER_JOB = 12;
/** A draft is one request: a group needing more than this many tokens of source is left to the on-demand feature. */
const DRAFT_BATCH_TOKENS = 3500;
const DRAFT_OUTPUT_TOKENS = 8192;

export interface DraftOutcome {
  drafted: number;
  /** Why fewer drafts exist than the document has groups, in words; null when nothing was skipped. */
  note: string | null;
}

/**
 * Drafts of learning material for a freshly ingested document: revision notes for each group of theory.
 *
 * It reuses the revision-notes machinery the learner-facing feature already has — the same prompt, the same parser,
 * and above all the same validator, which keeps an item only when it traces to the notes it cites and a formula only
 * when the notes contain it — so there is one definition of "grounded" in the codebase. What differs is where the
 * result goes: a block in the document's preview, marked `ai_generated`, that a person reads, edits and approves
 * with everything else. Nothing here publishes anything, and a model's output passing the validator is not a claim
 * that it is right; it is the claim that it says nothing the source does not.
 *
 * With no model configured it does nothing and says so; it never writes placeholder material.
 */
@Injectable()
export class LearningDraftsService {
  private readonly logger = new Logger(LearningDraftsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: IngestionRepository,
    private readonly ai: AiService,
    private readonly engineConfig: EngineConfigService,
    private readonly audit: AuditService,
  ) {}

  async generate(job: IngestionJobRow, asset: ContentAssetRow, _params: IngestionParams): Promise<DraftOutcome> {
    if (!this.ai.configured) return { drafted: 0, note: 'no AI provider is configured, so no learning material was drafted' };

    const active = await this.engineConfig.rawActiveParams(job.tenantId);
    const explanation = parseExplanationParams(active.params);
    if (!explanation.ok) return { drafted: 0, note: 'the active configuration has no usable grounding settings, so no learning material was drafted' };
    const { chunk, grounding } = explanation.value.explanation;

    const blocks = await this.repo.blocksOfJob(job.tenantId, job.id);
    const alreadyDrafted = new Set(blocks.map((b) => draftOf(b.contentJson)?.groupKey).filter((k): k is string => typeof k === 'string'));
    const sources = blocks.filter(
      (b) =>
        b.kind === 'theory' &&
        // A heading on its own is not material: it is not published, so notes must not cite it.
        !isFragment(b) &&
        !draftOf(b.contentJson) &&
        readProvenance(b.contentJson).origin !== 'ai_generated' &&
        (b.status === 'extracted' || b.status === 'needs_review' || b.status === 'approved'),
    );

    const groups = new Map<string, ContentBlockRow[]>();
    for (const block of sources) {
      const key = groupKeyOf(block);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), block]);
    }

    const audience = await this.audienceOf(job.tenantId, asset.trackId);
    let drafted = 0;
    const skipped: string[] = [];

    for (const [groupKey, members] of groups) {
      if (alreadyDrafted.has(groupKey)) continue;
      if (drafted >= MAX_DRAFTS_PER_JOB) {
        skipped.push(`${groups.size - drafted} further group(s) were left to the on-demand revision-notes feature (limit of ${MAX_DRAFTS_PER_JOB} per document)`);
        break;
      }
      const ordered = [...members].sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || a.sortOrder - b.sortOrder);
      const text = ordered.map((b) => b.normalizedText ?? b.rawText).join('\n');
      const names = namesOf(ordered[0]!);
      const scopeTitle = names.subtopic ?? names.topic ?? names.chapter ?? ordered[0]!.title ?? 'this material';
      if (text.length < MIN_SOURCE_CHARS) {
        skipped.push(`"${scopeTitle}": too little theory to summarise`);
        continue;
      }

      const sourceBlocks = ordered.map((b, i) => ({
        blockId: b.id,
        title: b.title,
        text: b.normalizedText ?? b.rawText,
        contentHash: b.contentHash,
        sortOrder: i,
      }));
      const chunks = chunkBlocks(
        sourceBlocks.map((b) => ({ blockId: b.blockId, title: b.title, text: b.text, sortOrder: b.sortOrder })),
        { minTokens: chunk.min_tokens, maxTokens: Math.min(chunk.max_tokens, DRAFT_BATCH_TOKENS) },
      );
      const batches = packBatches(chunks, DRAFT_BATCH_TOKENS, 1);
      if (!batches) {
        skipped.push(`"${scopeTitle}": too long for one draft; students can still generate notes for it on demand`);
        continue;
      }

      try {
        const reply = await this.ai.generateJson(
          {
            task: 'revision_notes',
            temperature: 0.2,
            maxOutputTokens: DRAFT_OUTPUT_TOKENS,
            prompt: buildNotesPrompt({ scopeTitle, scopePath: [names.chapter, names.topic, names.subtopic].filter(Boolean).join(' › ') || scopeTitle, audience, chunks: batches[0]!, part: null }),
          },
          parseNotesReply,
        );
        const validation = validateNotes(reply.value, sourceBlocks, grounding.mostly_notes_min);
        if (!validation.ok) {
          skipped.push(`"${scopeTitle}": the draft was rejected (${validation.rejectedBecause})`);
          continue;
        }

        const rendered = renderNotesText(validation.notes);
        const draft: RevisionNotesDraft = {
          kind: 'revision_notes',
          notes: validation.notes,
          sourceBlockIds: validation.usedBlockIds,
          coveredBlockIds: ordered.map((b) => b.id),
          groupKey,
          groundingScore: validation.groundingScore,
          promptVersion: NOTES_PROMPT_VERSION,
          provider: reply.provider,
          model: reply.model,
        };
        const last = ordered[ordered.length - 1]!;
        await this.repo.insertBlock({
          tenantId: job.tenantId,
          jobId: job.id,
          assetId: asset.id,
          sourcePage: last.sourcePage ?? 1,
          kind: 'theory',
          format: 'callout',
          title: `Revision notes — ${scopeTitle}`,
          rawText: rendered,
          normalizedText: rendered,
          contentHash: hashText(rendered),
          classificationConfidence: 1,
          classifiedBy: 'model',
          subtopicId: ordered[0]!.subtopicId,
          taggingConfidence: ordered.reduce<number>((min, b) => Math.min(min, b.taggingConfidence ?? 0), 1),
          sortOrder: last.sortOrder,
          // Never `approved` and never auto-approved: a person reads it first. Status `needs_review` is what a
          // block waiting for a person looks like everywhere else, and a re-run keeps what a person has touched.
          status: 'needs_review',
          contentJson: setProvenance(
            { draft, mapping: (ordered[0]!.contentJson as { mapping?: unknown } | null)?.mapping ?? null, source: { assetId: asset.id, page: last.sourcePage } },
            { ...withAi(EXTRACTED, { task: 'revision_notes', provider: reply.provider, model: reply.model, at: new Date().toISOString() }), origin: 'ai_generated' },
          ),
        });
        drafted += 1;
      } catch (error) {
        skipped.push(`"${scopeTitle}": ${error instanceof Error ? error.message : 'the model could not be reached'}`);
        this.logger.warn(`job ${job.id}: learning draft for "${scopeTitle}" failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }

    if (drafted > 0) {
      await this.audit.record({
        tenantId: job.tenantId,
        action: 'ingestion_job.drafts_generated',
        entityType: 'ingestion_job',
        entityId: job.id,
        after: { drafted, skipped: skipped.length, promptVersion: NOTES_PROMPT_VERSION },
      });
    }
    return { drafted, note: skipped.length > 0 ? skipped.slice(0, 5).join('; ') : null };
  }

  private async audienceOf(tenantId: string, trackId: string | null): Promise<string> {
    if (!trackId) return 'a student studying this material. Use clear, precise language.';
    const [track] = await this.db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track || track.tenantId !== tenantId) return 'a student studying this material. Use clear, precise language.';
    return audienceFor({
      name: track.name,
      kind: track.kind ?? null,
      gradeLabel: track.gradeLabel ?? null,
      gradeOrdinal: track.gradeOrdinal ?? null,
      examFamily: track.examFamily ?? null,
    });
  }
}

/** Which group a theory block belongs to: its sub-topic when it has one, else the path its headings propose. */
export function groupKeyOf(block: Pick<ContentBlockRow, 'subtopicId' | 'contentJson'>): string | null {
  if (block.subtopicId) return `subtopic:${block.subtopicId}`;
  const key = (block.contentJson as { mapping?: { hierarchy?: { key?: unknown } | null } } | null)?.mapping?.hierarchy?.key;
  return typeof key === 'string' && key.length > 0 ? `path:${key}` : null;
}

/** The chapter, topic and sub-topic names the document's own headings gave a block, where it has any. */
function namesOf(block: Pick<ContentBlockRow, 'contentJson'>): { chapter: string | null; topic: string | null; subtopic: string | null } {
  const h = (block.contentJson as { mapping?: { hierarchy?: { chapter?: string | null; topic?: string | null; subtopic?: string | null } | null } } | null)?.mapping?.hierarchy;
  return { chapter: h?.chapter ?? null, topic: h?.topic ?? null, subtopic: h?.subtopic ?? null };
}
