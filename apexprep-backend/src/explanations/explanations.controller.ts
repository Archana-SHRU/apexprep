import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { AuthRateLimit, CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  AdminExplanationDto,
  AskQuestionDto,
  AskQuestionResponseDto,
  ExplanationDto,
  ExplanationQueryDto,
  ReindexResultDto,
  ReportQuestionDto,
  ReportResultDto,
  ReviewExplanationDto,
} from './dto/explanations.dto';
import { ExplanationsService } from './explanations.service';

const uuid = new ParseUUIDPipe();

/**
 * The student side of the explanation system: read the explanation for a question you have
 * answered, and report one that is wrong.
 *
 * Both routes carry `practice:use`, the STUDENT permission — an explanation is part of
 * practising, and staff use the admin routes below, which show the provenance a student
 * never sees.
 */
@ApiTags('explanations')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('questions')
@RequirePermissions('practice:use')
export class ExplanationsController {
  constructor(private readonly explanations: ExplanationsService) {}

  @Get(':id/explanation')
  // On a cache miss this route makes an embedding call and one or two generation calls to an
  // external provider, so it is metered on the stricter bucket. Left on the default bucket a
  // single student could drive a hundred generations a minute — a billing and provider-quota
  // drain, and each request occupies a worker for the whole provider timeout.
  @AuthRateLimit()
  @ApiOperation({
    summary: 'The explanation for a question you have answered',
    description:
      'Resolution order: the approved official solution, then an explanation grounded in the published theory, then general subject knowledge. ' +
      'A general-knowledge explanation carries the notice "Not from official notes — pending review". ' +
      'When the student\'s last attempt on this question was a particular wrong option, the variant written for that distractor is returned. ' +
      'Nothing about retrieval, grounding or the provider appears in this payload.',
  })
  @ApiOkResponse({ type: ExplanationDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'The question has not been attempted yet' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'EXPLANATION_UNAVAILABLE — failed its safety checks, withdrawn after reports, or waiting for a teacher',
  })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'AI_NOT_CONFIGURED or AI_PROVIDER_UNAVAILABLE' })
  forStudent(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ExplanationDto> {
    return this.explanations.forStudent(auth, id);
  }

  @Post(':id/ask')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Ask a specific doubt about this question',
    description:
      'Answers your doubt in the context of the question, official solution and course notes. ' +
      'Requires having submitted an attempt on the question first.',
  })
  @ApiOkResponse({ type: AskQuestionResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Answer this question first before asking questions about it' })
  ask(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: AskQuestionDto,
  ): Promise<AskQuestionResponseDto> {
    return this.explanations.ask(auth, id, dto);
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Report a question or its explanation',
    description:
      'Opens a review task. One open report per student per question, so a second report is a conflict rather than a way to inflate the count. ' +
      'Once the configured number of distinct students have reported, every active explanation for the question is unpublished — kept, not deleted — and sent to a reviewer.',
  })
  @ApiCreatedResponse({ type: ReportResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'You have already reported this question' })
  report(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: ReportQuestionDto): Promise<ReportResultDto> {
    return this.explanations.report(auth, id, dto);
  }
}

/**
 * The reviewer's side. `review:manage` is an ADMIN permission.
 *
 * These exist because Phase 6's approval rules need somewhere to be acted on: an explanation
 * held for mandatory approval is only released by a human, and the queue that holds it is the
 * existing `review_tasks` table. Nothing here is a new workflow.
 */
@ApiTags('explanations')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('admin')
@RequirePermissions('review:manage')
export class ExplanationsAdminController {
  constructor(private readonly explanations: ExplanationsService) {}

  @Get('questions/:id/explanation')
  @ApiOperation({
    summary: 'The explanation with its provenance, for review',
    description:
      'Everything the student payload hides: the tier, the computed grounding score and the blocks that supported it, how far retrieval widened, the provider and model, the answer the model argued for, and why a student would not be shown it.',
  })
  @ApiOkResponse({ type: AdminExplanationDto })
  forAdmin(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: ExplanationQueryDto,
  ): Promise<AdminExplanationDto> {
    return this.explanations.forAdmin(auth, id, query.optionKey ?? null);
  }

  @Post('explanations/:id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or reject an explanation',
    description:
      'Approving is what releases an explanation on a track that requires human approval. Rejecting takes it out of circulation without deleting it. Both write an audit row naming the reviewer.',
  })
  @ApiOkResponse({ type: AdminExplanationDto })
  review(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: ReviewExplanationDto,
  ): Promise<AdminExplanationDto> {
    return this.explanations.review(auth, id, dto.decision, dto.note);
  }

  @Post('subtopics/:id/theory-embeddings')
  @HttpCode(HttpStatus.OK)
  // One embedding call per published theory block of the sub-topic, so the cost of a single
  // request scales with the content. Metered for the same reason as the student route above.
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Embed a sub-topic’s published theory for semantic retrieval',
    description:
      'Blocks whose text has not changed since last time are skipped (`block_embeddings.content_hash`). Needs the pgvector extension and a provider that can embed; without either the call reports that rather than half-indexing.',
  })
  @ApiOkResponse({ type: ReindexResultDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'pgvector missing, or no embedding provider configured' })
  reindex(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ReindexResultDto> {
    return this.explanations.reindexSubtopic(auth, id);
  }
}
