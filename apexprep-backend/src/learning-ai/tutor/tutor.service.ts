import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import type { TutorConversationRow, TutorIntent, TutorMessageRow } from '../../database/schema';
import { EngineConfigService } from '../../engine-config/engine-config.service';
import { parseExplanationParams, type ExplanationParams } from '../../explanations/explanation-params';
import { TheoryRetrievalService } from '../../explanations/theory-retrieval.service';
import type { AnswerKey } from '../../practice/grading';
import { PracticeRepository } from '../../practice/practice.repository';
import { QuestionsRepository } from '../../questions/questions.repository';
import { QuestionsService } from '../../questions/questions.service';
import type { StudentQuestionView } from '../../questions/student-question.view';
import { audienceFor } from '../audience';
import type { StartConversationDto, TutorConversationDto, TutorMessageDto, TutorMessageInputDto, TutorReplyDto } from '../dto/learning-ai.dto';
import { LearningAiRepository } from '../learning-ai.repository';
import { findAnswerLeaks, type LeakAnswer } from '../leakage';
import { buildTutorPrompt, parseTutorReply, TUTOR_HISTORY_TURNS, TUTOR_PROMPT_VERSION, type TutorReply } from './tutor.prompt';

/** A conversation about the same context is continued, not restarted, within this window. */
const REUSE_WINDOW_MS = 6 * 60 * 60 * 1000;
const OUTPUT_TOKENS = 3072;

/**
 * The AI home tutor: short, contextual follow-up conversations about the question or topic a student is
 * working on.
 *
 * It is anchored, not general. Every conversation belongs to a sub-topic (and optionally a question);
 * the prompt carries that context, the student's own recorded attempt and the retrieved notes, and a
 * message the model judges off-topic is answered with a fixed redirect rather than the model's text.
 *
 * Answer leakage is enforced here, not trusted to the prompt. Until the student has answered — and on
 * any request for a hint — the model is not given the answer at all, and its reply is checked against
 * the authoritative key with the same detector the other features use. A reply that still leaks is
 * regenerated once, then replaced by a safe hint.
 */
@Injectable()
export class TutorService {
  private readonly logger = new Logger(TutorService.name);

  constructor(
    private readonly repo: LearningAiRepository,
    private readonly ai: AiService,
    private readonly engineConfig: EngineConfigService,
    private readonly retrieval: TheoryRetrievalService,
    private readonly practice: PracticeRepository,
    private readonly questions: QuestionsService,
    private readonly questionRows: QuestionsRepository,
  ) {}

  async start(auth: AuthContext, dto: StartConversationDto): Promise<TutorConversationDto> {
    const ctx = await this.repo.subtopicContext(auth.tenantId, dto.subtopicId);
    if (!ctx) throw AppException.notFound('Sub-topic not found');
    let question: StudentQuestionView | null = null;
    if (dto.questionId) question = await this.publishedQuestion(auth, dto.questionId);

    const since = new Date(Date.now() - REUSE_WINDOW_MS);
    const anchor = question ? { id: question.id, version: question.version } : null;
    const conversation =
      (await this.repo.reusableConversation(auth.tenantId, auth.userId, ctx.subtopicId, anchor, since)) ??
      (await this.repo.insertConversation({
        tenantId: auth.tenantId,
        userId: auth.userId,
        subtopicId: ctx.subtopicId,
        questionId: question?.id ?? null,
        questionVersion: question?.version ?? null,
      }));
    return this.toConversationDto(auth, conversation);
  }

  async get(auth: AuthContext, id: string): Promise<TutorConversationDto> {
    return this.toConversationDto(auth, await this.requireConversation(auth, id));
  }

  async send(auth: AuthContext, id: string, dto: TutorMessageInputDto): Promise<TutorReplyDto> {
    const conversation = await this.requireConversation(auth, id);
    const ctx = await this.repo.subtopicContext(auth.tenantId, conversation.subtopicId);
    if (!ctx) throw AppException.notFound('This topic is no longer available');
    const intent: TutorIntent = dto.intent ?? 'free';

    const question = conversation.questionId ? await this.publishedQuestion(auth, conversation.questionId) : null;
    const key = question ? await this.practice.questionForGrading(auth.tenantId, question.id) : undefined;
    const attempt = question ? await this.repo.latestAttempt(auth.tenantId, auth.userId, question.id) : undefined;
    const answered = attempt !== undefined;
    // The answer is only ever put in front of the model once the student has answered — and never for a hint.
    const revealAllowed = question !== null && answered && intent !== 'hint';

    if (intent === 'why_wrong' && question && !answered) {
      return this.store(auth, conversation.id, dto.message, intent, {
        body: 'Submit your answer first, and then I can go through exactly where it went wrong. If you are stuck now, ask me for a hint.',
        steps: [],
        payload: { canned: 'why_wrong_before_answer' },
      });
    }
    if (!this.ai.configured) {
      throw AppException.unavailable('The AI tutor needs an AI provider, and none is configured on this server', 'AI_NOT_CONFIGURED');
    }

    const params = await this.explanationParams(auth.tenantId);
    const retrieval = await this.retrieval.retrieve(
      auth.tenantId,
      { subtopicId: ctx.subtopicId, topicId: ctx.topicId, chapterId: ctx.chapterId },
      [question?.stem ?? ctx.subtopicName, dto.message].join('\n'),
      params,
    );
    const chunks = retrieval.selected.map((c) => c.chunk);
    const history = (await this.repo.messages(auth.tenantId, conversation.id)).slice(-TUTOR_HISTORY_TURNS).map((m) => ({ role: m.role, body: m.body }));

    const leakAnswer = question && key ? toLeakAnswer(question, key) : null;
    const promptInput = {
      audience: audienceFor(ctx.track),
      subtopicPath: `${ctx.subjectName} › ${ctx.chapterName} › ${ctx.topicName} › ${ctx.subtopicName}`,
      question: question ? { type: question.type, stem: question.stem, options: question.options } : null,
      attempt: attempt && question ? { answerText: describeResponse(attempt.response, question), outcome: attempt.outcome } : null,
      revealedAnswer: revealAllowed && question && key ? describeAnswer(key, question) : null,
      intent,
      history,
      message: dto.message,
      chunks,
      retryAfterLeak: false,
    };

    let reply = await this.ask(promptInput);
    let leakCheck: { checked: boolean; leaks: string[]; retried: boolean; fallback: boolean } = { checked: false, leaks: [], retried: false, fallback: false };
    if (reply.value.onTopic && leakAnswer && !revealAllowed) {
      let leaks = findAnswerLeaks(`${reply.value.reply}\n${reply.value.steps.join('\n')}`, leakAnswer);
      leakCheck = { checked: true, leaks: leaks.map((l) => l.rule), retried: false, fallback: false };
      if (leaks.length > 0) {
        reply = await this.ask({ ...promptInput, retryAfterLeak: true });
        leaks = reply.value.onTopic ? findAnswerLeaks(`${reply.value.reply}\n${reply.value.steps.join('\n')}`, leakAnswer) : [];
        leakCheck = { checked: true, leaks: leaks.map((l) => l.rule), retried: true, fallback: leaks.length > 0 };
        if (leaks.length > 0) {
          this.logger.warn(`tutor reply for question ${question!.id} still revealed the answer after a retry; serving a safe hint`);
          return this.store(auth, conversation.id, dto.message, intent, {
            body: await this.safeHint(auth, question!.id, leakAnswer, chunks[0]?.title ?? ctx.subtopicName),
            steps: [],
            payload: { provider: reply.provider, model: reply.model, promptVersion: TUTOR_PROMPT_VERSION, leakCheck, revealAllowed },
          });
        }
      }
    }

    if (!reply.value.onTopic) {
      return this.store(auth, conversation.id, dto.message, intent, {
        body: `I can only help with ${ctx.subtopicName}${question ? ' and the question you are working on' : ''} here. Ask me about that — for example, for a hint or to explain an idea more simply.`,
        steps: [],
        payload: { provider: reply.provider, model: reply.model, promptVersion: TUTOR_PROMPT_VERSION, offTopic: true },
      });
    }

    const retrieved = new Set(chunks.flatMap((c) => c.blockIds));
    const cited = reply.value.citedBlockIds.filter((b) => retrieved.has(b));
    return this.store(auth, conversation.id, dto.message, intent, {
      body: reply.value.reply,
      steps: reply.value.steps,
      payload: {
        provider: reply.provider,
        model: reply.model,
        promptVersion: TUTOR_PROMPT_VERSION,
        citedBlockIds: cited,
        retrievalScope: retrieval.scope,
        leakCheck,
        revealAllowed,
      },
    });
  }

  // ---------------------------------------------------------------- internals

  private ask(input: Parameters<typeof buildTutorPrompt>[0]): Promise<{ provider: string; model: string; value: TutorReply }> {
    return this.ai.generateJson({ task: 'tutor', temperature: 0.3, maxOutputTokens: OUTPUT_TOKENS, prompt: buildTutorPrompt(input) }, parseTutorReply);
  }

  /** A hint that cannot leak: the question's own authored hint when it is clean, otherwise a pointer to the notes. */
  private async safeHint(auth: AuthContext, questionId: string, leakAnswer: LeakAnswer, noteTitle: string): Promise<string> {
    const row = await this.questionRows.findById(auth.tenantId, questionId);
    const hint = (row?.hints ?? []).find((h) => findAnswerLeaks(h, leakAnswer).length === 0);
    if (hint) return `Here is a hint: ${hint}`;
    return `I don’t want to give the answer away before you’ve tried it. Start from what your notes say about "${noteTitle}" — which idea there applies to this question, and what does it tell you to do first?`;
  }

  private async store(
    auth: AuthContext,
    conversationId: string,
    message: string,
    intent: TutorIntent,
    tutor: { body: string; steps: string[]; payload: Record<string, unknown> },
  ): Promise<TutorReplyDto> {
    const { student, tutor: reply } = await this.repo.appendExchange(
      auth.tenantId,
      conversationId,
      { intent, body: message, payload: {} },
      { intent, body: tutor.body, payload: { ...tutor.payload, steps: tutor.steps } },
    );
    return { student: toMessageDto(student), tutor: toMessageDto(reply) };
  }

  private async requireConversation(auth: AuthContext, id: string): Promise<TutorConversationRow> {
    // Scoped to the learner as well as the organisation: a conversation is private to the student who had it.
    const conversation = await this.repo.findConversation(auth.tenantId, auth.userId, id);
    if (!conversation) throw AppException.notFound('Conversation not found');
    return conversation;
  }

  private async publishedQuestion(auth: AuthContext, questionId: string): Promise<StudentQuestionView> {
    try {
      return await this.questions.studentView(auth.tenantId, questionId);
    } catch {
      throw AppException.notFound('Question not found');
    }
  }

  private async toConversationDto(auth: AuthContext, conversation: TutorConversationRow): Promise<TutorConversationDto> {
    const messages = await this.repo.messages(auth.tenantId, conversation.id);
    const answered = conversation.questionId ? (await this.repo.latestAttempt(auth.tenantId, auth.userId, conversation.questionId)) !== undefined : false;
    return {
      id: conversation.id,
      subtopicId: conversation.subtopicId,
      questionId: conversation.questionId,
      answered,
      messages: messages.map(toMessageDto),
    };
  }

  private async explanationParams(tenantId: string): Promise<ExplanationParams> {
    const active = await this.engineConfig.rawActiveParams(tenantId);
    const parsed = parseExplanationParams(active.params);
    if (!parsed.ok) throw AppException.unprocessable('The active configuration has no usable retrieval settings', 'ENGINE_CONFIG_INVALID');
    return parsed.value;
  }
}

/** The student-facing projection: provider, prompt and leak-check detail stay in the payload. */
function toMessageDto(m: TutorMessageRow): TutorMessageDto {
  const payload = m.payload ?? {};
  const cited = Array.isArray(payload.citedBlockIds) ? payload.citedBlockIds : [];
  return {
    id: m.id,
    role: m.role,
    intent: m.intent,
    body: m.body,
    steps: Array.isArray(payload.steps) ? (payload.steps as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    grounded: m.role === 'tutor' && cited.length > 0,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toLeakAnswer(question: Pick<StudentQuestionView, 'type' | 'stem' | 'options'>, key: AnswerKey): LeakAnswer {
  return { type: question.type, correctOptionKeys: key.correctOptionKeys, options: question.options, correctNumeric: key.correctNumeric, stem: question.stem };
}

/** The correct answer in words, for the model — only ever built when it may be discussed. */
export function describeAnswer(key: AnswerKey, question: Pick<StudentQuestionView, 'options'>): string {
  if (key.correctOptionKeys.length > 0) {
    return key.correctOptionKeys.map((k) => `${k} (${question.options.find((o) => o.key === k)?.text ?? ''})`).join(', ');
  }
  if (key.correctNumeric !== null) {
    return `${key.correctNumeric}${key.numericTolerance && key.numericTolerance !== '0' ? ` (accepted within ${key.numericTolerance}, ${key.toleranceMode})` : ''}`;
  }
  if (key.matrixAnswer) return Object.entries(key.matrixAnswer).map(([l, r]) => `${l} → ${r.join(', ')}`).join('; ');
  return 'marked by a teacher (no automatic key)';
}

/** What the student submitted, in words. */
export function describeResponse(response: Record<string, unknown>, question: Pick<StudentQuestionView, 'options'>): string {
  const keys = response.option_keys ?? response.optionKeys;
  if (Array.isArray(keys)) {
    return keys.map((k) => `${String(k)} (${question.options.find((o) => o.key === k)?.text ?? ''})`).join(', ') || 'no option';
  }
  if (typeof response.value === 'string' || typeof response.value === 'number') return String(response.value);
  if (typeof response.text === 'string') return `"${response.text.slice(0, 300)}"`;
  if (response.matrix && typeof response.matrix === 'object') return JSON.stringify(response.matrix);
  return 'an answer';
}
