import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { isUniqueViolation } from '../../database/pg-error';
import type { NoteScopeLevel, RevisionNotesRow } from '../../database/schema';
import { EngineConfigService } from '../../engine-config/engine-config.service';
import { parseExplanationParams, type ExplanationParams } from '../../explanations/explanation-params';
import { audienceFor } from '../audience';
import type { RevisionNotesDto } from '../dto/learning-ai.dto';
import { LearningAiRepository, type ScopeContext } from '../learning-ai.repository';
import { chunkSources, packBatches, sourceHash, type SourceBlock } from '../source';
import { buildNotesMergePrompt, buildNotesPrompt, NOTES_PROMPT_VERSION, parseNotesReply, type RawNotes } from './notes.prompt';
import { validateNotes, type ValidatedNotes } from './notes.validation';

/**
 * How much source one request may process. A scope is summarised in batches of `BATCH_TOKENS`, at
 * most `MAX_BATCHES` of them, then merged — so a 100-page chapter is never one prompt, and a whole
 * track is refused with a clear message instead of being silently truncated.
 */
export const NOTES_BATCH_TOKENS = 3500;
export const NOTES_MAX_BATCHES = 12;
const MAX_SOURCE_BLOCKS = 1500;
/** A failed generation is not retried for the same inputs within this window. */
const REJECTION_COOLDOWN_MS = 30 * 60 * 1000;
const NOTES_OUTPUT_TOKENS = 8192;

/**
 * AI revision notes: short notes, key points, concepts, formulas, common mistakes and a quick-revision
 * list for any published syllabus node, written only from that node's published theory.
 *
 * The cache key is (scope, source hash, prompt version). The source hash covers every source block's
 * content hash, so editing, adding or removing a note under the scope makes the cached notes stale and
 * the next request regenerates them; nothing else does.
 */
@Injectable()
export class RevisionNotesService {
  private readonly logger = new Logger(RevisionNotesService.name);

  constructor(
    private readonly repo: LearningAiRepository,
    private readonly ai: AiService,
    private readonly engineConfig: EngineConfigService,
    private readonly audit: AuditService,
  ) {}

  /** The cached notes for a scope, or what state it is in. Never calls a provider. */
  async read(auth: AuthContext, level: NoteScopeLevel, id: string): Promise<RevisionNotesDto> {
    const scope = await this.requireScope(auth, level, id);
    const blocks = await this.repo.theoryInScope(auth.tenantId, level, id, MAX_SOURCE_BLOCKS + 1);
    if (blocks.length === 0) return this.toDto(scope, null, 'no_source', false, blocks);
    const active = await this.repo.activeNotes(auth.tenantId, level, id);
    if (!active) return this.toDto(scope, null, 'not_generated', false, blocks);
    const fresh = active.sourceHash === sourceHash(blocks) && active.promptVersion === NOTES_PROMPT_VERSION;
    return this.toDto(scope, fresh ? active : null, fresh ? 'ready' : 'outdated', true, blocks);
  }

  /** The notes for a scope: from the cache when still valid, otherwise generated now. */
  async generate(auth: AuthContext, level: NoteScopeLevel, id: string): Promise<RevisionNotesDto> {
    const scope = await this.requireScope(auth, level, id);
    const blocks = await this.repo.theoryInScope(auth.tenantId, level, id, MAX_SOURCE_BLOCKS + 1);
    if (blocks.length === 0) {
      throw AppException.unprocessable(
        'There are no published notes here yet, so there is nothing to summarise. Notes appear once your organisation publishes content for this topic.',
        'NO_SOURCE_CONTENT',
      );
    }
    if (blocks.length > MAX_SOURCE_BLOCKS) throw this.tooLarge(scope);

    const hash = sourceHash(blocks);
    const active = await this.repo.activeNotes(auth.tenantId, level, id);
    if (active && active.sourceHash === hash && active.promptVersion === NOTES_PROMPT_VERSION) {
      return this.toDto(scope, active, 'ready', true, blocks);
    }
    const since = new Date(Date.now() - REJECTION_COOLDOWN_MS);
    if (await this.repo.recentRejectedNotes(auth.tenantId, level, id, hash, NOTES_PROMPT_VERSION, since)) {
      throw this.rejected();
    }
    if (!this.ai.configured) {
      throw AppException.unavailable('Revision notes need an AI provider, and none is configured on this server', 'AI_NOT_CONFIGURED');
    }

    const params = await this.params(auth.tenantId);
    const limits = { minTokens: params.explanation.chunk.min_tokens, maxTokens: Math.min(params.explanation.chunk.max_tokens, NOTES_BATCH_TOKENS) };
    const batches = packBatches(chunkSources(blocks, limits), NOTES_BATCH_TOKENS, NOTES_MAX_BATCHES);
    if (!batches) throw this.tooLarge(scope);

    const audience = audienceFor(scope.track);
    let raw: RawNotes;
    let provider = '';
    let model = '';
    if (batches.length === 1) {
      const result = await this.ai.generateJson(
        { task: 'revision_notes', temperature: 0.2, maxOutputTokens: NOTES_OUTPUT_TOKENS, prompt: buildNotesPrompt({ scopeTitle: scope.name, scopePath: scope.path, audience, chunks: batches[0]!, part: null }) },
        parseNotesReply,
      );
      ({ value: raw, provider, model } = result);
    } else {
      // Map: each part separately, in order (sequential, so one request never fans out a burst of provider calls).
      const parts: RawNotes[] = [];
      for (const [i, batch] of batches.entries()) {
        const result = await this.ai.generateJson(
          {
            task: 'revision_notes',
            temperature: 0.2,
            maxOutputTokens: NOTES_OUTPUT_TOKENS,
            prompt: buildNotesPrompt({ scopeTitle: scope.name, scopePath: scope.path, audience, chunks: batch, part: { index: i + 1, of: batches.length } }),
          },
          parseNotesReply,
        );
        parts.push(result.value);
      }
      // Reduce: merge the grounded parts. Validation below re-checks every citation against the real source.
      const merged = await this.ai.generateJson(
        { task: 'revision_notes', temperature: 0.2, maxOutputTokens: NOTES_OUTPUT_TOKENS, prompt: buildNotesMergePrompt({ scopeTitle: scope.name, scopePath: scope.path, audience, parts }) },
        parseNotesReply,
      );
      ({ value: raw, provider, model } = merged);
    }

    const validation = validateNotes(raw, blocks, params.explanation.grounding.mostly_notes_min);
    const row = await this.store(auth, scope, blocks, hash, validation, provider, model, batches.length, active);

    await this.audit.record({
      tenantId: auth.tenantId,
      action: validation.ok ? 'revision_notes.generated' : 'revision_notes.rejected',
      entityType: 'revision_notes',
      entityId: row.id,
      after: {
        scopeLevel: level,
        scopeId: id,
        batches: batches.length,
        sourceBlocks: blocks.length,
        groundingScore: validation.groundingScore,
        dropped: validation.dropped.length,
        rejectedBecause: validation.rejectedBecause,
        provider,
        model,
      },
    });

    if (!validation.ok) {
      this.logger.warn(`revision notes for ${level} ${id} rejected: ${validation.rejectedBecause}`);
      throw this.rejected();
    }
    return this.toDto(scope, row, 'ready', false, blocks);
  }

  // ---------------------------------------------------------------- internals

  private async store(
    auth: AuthContext,
    scope: ScopeContext,
    blocks: readonly SourceBlock[],
    hash: string,
    validation: ReturnType<typeof validateNotes>,
    provider: string,
    model: string,
    batches: number,
    active: RevisionNotesRow | undefined,
  ): Promise<RevisionNotesRow> {
    const values = {
      tenantId: auth.tenantId,
      scopeLevel: scope.level,
      scopeId: scope.id,
      sourceHash: hash,
      sourceBlockIds: validation.ok ? validation.usedBlockIds : [],
      promptVersion: NOTES_PROMPT_VERSION,
      provider,
      model,
      status: validation.ok ? ('active' as const) : ('rejected' as const),
      content: validation.notes as unknown as Record<string, unknown>,
      groundingScore: validation.groundingScore,
      diagnostics: { batches, sourceBlockCount: blocks.length, dropped: validation.dropped, rejectedBecause: validation.rejectedBecause },
      generatedBy: auth.userId,
    };
    try {
      if (validation.ok && active) await this.repo.supersedeNotes(auth.tenantId, active.id);
      return await this.repo.insertNotes(values);
    } catch (error) {
      // Two students generated the same notes at once: the database kept one active row, serve that.
      if (validation.ok && isUniqueViolation(error)) {
        const winner = await this.repo.activeNotes(auth.tenantId, scope.level, scope.id);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async requireScope(auth: AuthContext, level: NoteScopeLevel, id: string): Promise<ScopeContext> {
    const scope = await this.repo.scopeContext(auth.tenantId, level, id);
    if (!scope) throw AppException.notFound(`${level[0]!.toUpperCase()}${level.slice(1)} not found`);
    return scope;
  }

  private async params(tenantId: string): Promise<ExplanationParams> {
    const active = await this.engineConfig.rawActiveParams(tenantId);
    const parsed = parseExplanationParams(active.params);
    if (!parsed.ok) throw AppException.unprocessable('The active configuration has no usable grounding settings', 'ENGINE_CONFIG_INVALID');
    return parsed.value;
  }

  private tooLarge(scope: ScopeContext): AppException {
    return AppException.unprocessable(
      `${scope.name} has more material than can be summarised in one go. Open a chapter or topic inside it and create notes there.`,
      'SCOPE_TOO_LARGE',
    );
  }

  private rejected(): AppException {
    return AppException.unprocessable(
      'Notes could not be written from this material without adding things the notes do not say, so none are shown. Try a narrower topic, or try again later.',
      'AI_OUTPUT_REJECTED',
    );
  }

  private toDto(scope: ScopeContext, row: RevisionNotesRow | null, state: RevisionNotesDto['state'], cached: boolean, blocks: readonly SourceBlock[]): RevisionNotesDto {
    const content = row?.content as unknown as ValidatedNotes | undefined;
    const titles = new Map(blocks.map((b) => [b.blockId, b.title]));
    return {
      state,
      scope: { level: scope.level, id: scope.id, name: scope.name, path: scope.path },
      cached,
      sourceBlockCount: blocks.length,
      notes:
        row && content
          ? {
              id: row.id,
              title: content.title,
              overview: content.overview,
              keyPoints: content.keyPoints,
              concepts: content.concepts,
              formulas: content.formulas,
              commonMistakes: content.commonMistakes,
              quickRevision: content.quickRevision,
              sources: row.sourceBlockIds.map((blockId) => ({ blockId, title: titles.get(blockId) ?? null })),
              generatedAt: row.generatedAt.toISOString(),
            }
          : null,
    };
  }
}
