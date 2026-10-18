import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { AuthRateLimit, CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  GeneratedQuestionsResultDto,
  GenerateQuestionsDto,
  NotesScopeDto,
  RevisionNotesDto,
  StartConversationDto,
  TutorConversationDto,
  TutorMessageInputDto,
  TutorReplyDto,
  VisualExplanationDto,
} from './dto/learning-ai.dto';
import { LearningAiRepository } from './learning-ai.repository';
import { RevisionNotesService } from './notes/revision-notes.service';
import { QuestionGenerationService } from './questions/question-generation.service';
import { TutorService } from './tutor/tutor.service';
import { VisualExplanationService } from './visuals/visual-explanation.service';

const uuid = new ParseUUIDPipe();

/*
 * The student-facing learning-AI routes. All carry `practice:use` — they are part of studying — and every
 * route that can call a provider is on the stricter `@AuthRateLimit()` bucket, like the explanation route,
 * so one student cannot drive a stream of paid generations. Everything is scoped to the caller's
 * organisation, and tutor conversations to the caller themselves.
 */

@ApiTags('learning-ai')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('revision-notes')
@RequirePermissions('practice:use')
export class RevisionNotesController {
  constructor(private readonly notes: RevisionNotesService) {}

  @Get()
  @ApiOperation({
    summary: 'Cached revision notes for a syllabus node, or the state they are in',
    description: 'Never calls a provider. `state` is ready, outdated (the notes changed since), not_generated, or no_source (nothing published to summarise).',
  })
  @ApiOkResponse({ type: RevisionNotesDto })
  read(@CurrentAuth() auth: AuthContext, @Query() query: NotesScopeDto): Promise<RevisionNotesDto> {
    return this.notes.read(auth, query.level, query.id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Short notes, key points, concepts, formulas, common mistakes and a quick-revision list',
    description:
      'Written only from the published theory under the node, in bounded batches merged into one set. Every item cites the notes it came from; ' +
      'items the notes do not support are dropped, and notes that fail grounding are never shown. Cached until the source content or prompt changes.',
  })
  @ApiOkResponse({ type: RevisionNotesDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'NO_SOURCE_CONTENT, SCOPE_TOO_LARGE or AI_OUTPUT_REJECTED' })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'AI_NOT_CONFIGURED or AI_PROVIDER_UNAVAILABLE' })
  generate(@CurrentAuth() auth: AuthContext, @Body() dto: NotesScopeDto): Promise<RevisionNotesDto> {
    return this.notes.generate(auth, dto.level, dto.id);
  }
}

@ApiTags('learning-ai')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('practice/generated-questions')
@RequirePermissions('practice:use')
export class GeneratedQuestionsController {
  constructor(private readonly generation: QuestionGenerationService) {}

  @Post()
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Fresh practice questions at your adaptive level, written from the published notes',
    description:
      'The adaptive engine sets the target level from your ability in this sub-topic. Each question is validated (shape, a worked solution that ' +
      'reaches its own key, no answer leakage, grounding, no near-duplicates) before it joins the practice pool; the engine then serves it like ' +
      'any other question. No answers are returned here. Limited per student per day.',
  })
  @ApiCreatedResponse({ type: GeneratedQuestionsResultDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'NO_SOURCE_CONTENT or AI_OUTPUT_REJECTED (nothing passed validation)' })
  generate(@CurrentAuth() auth: AuthContext, @Body() dto: GenerateQuestionsDto): Promise<GeneratedQuestionsResultDto> {
    return this.generation.generate(auth, dto);
  }
}

@ApiTags('learning-ai')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('tutor/conversations')
@RequirePermissions('practice:use')
export class TutorController {
  constructor(private readonly tutor: TutorService) {}

  @Post()
  @ApiOperation({
    summary: 'Open (or continue) a tutor conversation about a sub-topic or a question',
    description: 'A recent open conversation about the same context is continued rather than restarted.',
  })
  @ApiCreatedResponse({ type: TutorConversationDto })
  start(@CurrentAuth() auth: AuthContext, @Body() dto: StartConversationDto): Promise<TutorConversationDto> {
    return this.tutor.start(auth, dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: TutorConversationDto })
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<TutorConversationDto> {
    return this.tutor.get(auth, id);
  }

  @Post(':id/messages')
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Ask the tutor a follow-up',
    description:
      'Answered in the context of the conversation’s sub-topic and question, your submitted answer, the course notes and the recent turns. ' +
      'Before you have answered — and whenever you ask for a hint — the tutor does not reveal the answer; its reply is checked against the key. ' +
      'Off-topic messages are redirected.',
  })
  @ApiCreatedResponse({ type: TutorReplyDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'AI_NOT_CONFIGURED or AI_PROVIDER_UNAVAILABLE' })
  send(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: TutorMessageInputDto): Promise<TutorReplyDto> {
    return this.tutor.send(auth, id, dto);
  }
}

@ApiTags('learning-ai')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
@RequirePermissions('practice:use')
export class VisualsController {
  constructor(private readonly visuals: VisualExplanationService) {}

  @Post('questions/:id/visual')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Explain this question visually',
    description:
      'Analyses the question and chooses the most useful format — diagram, graph, step-by-step, animation, illustration, an image only when ' +
      'nothing drawn will do, or none. The visual shows the setup and the concept and never the answer; every label is checked against the key. ' +
      'Cached per question version.',
  })
  @ApiOkResponse({ type: VisualExplanationDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'AI_OUTPUT_REJECTED: no safe visual could be made' })
  forQuestion(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<VisualExplanationDto> {
    return this.visuals.forQuestion(auth, id);
  }

  @Get('visuals/:id/image')
  @ApiOperation({ summary: 'The stored image of an image visual' })
  async image(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<StreamableFile> {
    const { bytes, contentType } = await this.visuals.image(auth, id);
    return new StreamableFile(bytes, { type: contentType, disposition: 'inline', length: bytes.length });
  }
}

/** Provenance of generated questions for reviewers: what was generated, from what, and why rejections failed. */
@ApiTags('learning-ai')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/generated-questions')
@RequirePermissions('questions:manage')
export class GeneratedQuestionsAdminController {
  constructor(private readonly repo: LearningAiRepository) {}

  @Get()
  @ApiOperation({ summary: 'Recent AI question generations with provenance and validation outcome' })
  async list(@CurrentAuth() auth: AuthContext, @Query('subtopicId') subtopicId?: string): Promise<Record<string, unknown>[]> {
    const scoped = subtopicId && /^[0-9a-f-]{36}$/i.test(subtopicId) ? subtopicId : null;
    const rows = await this.repo.generatedForAdmin(auth.tenantId, scoped, 100);
    return rows.map((r) => ({
      id: r.id,
      questionId: r.questionId,
      subtopicId: r.subtopicId,
      status: r.status,
      questionType: r.questionType,
      targetLevel: r.targetLevel,
      provider: r.provider,
      model: r.model,
      promptVersion: r.promptVersion,
      sourceBlockIds: r.sourceBlockIds,
      validation: r.validation,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
