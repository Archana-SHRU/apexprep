import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { AttemptsService } from './attempts.service';
import {
  AttemptResultDto,
  CreatePracticeSessionDto,
  EndSessionDto,
  NextQuestionDto,
  PracticeSessionDto,
  RevealHintDto,
  RevealedHintDto,
  SessionEventsResultDto,
  SessionStartDto,
  SubmitAttemptDto,
  SubmitSessionEventsDto,
} from './dto/practice.dto';
import { PracticeService } from './practice.service';

const uuid = new ParseUUIDPipe();

/**
 * The student practice flow. `practice:use` is a STUDENT permission, so staff accounts
 * cannot drive a practice session, and every route is scoped to the caller's own sessions.
 */
@ApiTags('practice')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('practice')
@RequirePermissions('practice:use')
export class PracticeController {
  constructor(
    private readonly practice: PracticeService,
    private readonly attempts: AttemptsService,
  ) {}

  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start (or resume) a practice session for one sub-topic',
    description:
      'A student has at most one open session per sub-topic: if one is already open it is returned with `resumed: true`. On a first visit the ability row is created — L2, or seeded from the parent topic when the student has practised its other sub-topics — and inactivity decay is applied if they have been away.',
  })
  @ApiCreatedResponse({ type: SessionStartDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'ENGINE_CONFIG_MISSING' })
  createSession(@CurrentAuth() auth: AuthContext, @Body() dto: CreatePracticeSessionDto): Promise<SessionStartDto> {
    return this.practice.createSession(auth, dto);
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'One of your practice sessions' })
  @ApiOkResponse({ type: PracticeSessionDto })
  getSession(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PracticeSessionDto> {
    return this.practice.getSession(auth, id);
  }

  @Get('sessions/:id/next')
  @ApiOperation({
    summary: 'The next question the adaptive engine chooses',
    description:
      'Targets ~72% success, excludes anything attempted in the last 30 days and near-duplicates of what was already seen, makes every 5th question a probe half a level above target, and widens to the parent topic when fewer than 5 questions are eligible (raising a content-gap alert). Calling it again without answering returns the same question; `skip=true` skips it first. The payload carries no answer key, solution or engine difficulty.',
  })
  @ApiQuery({ name: 'skip', required: false, description: 'Skip the outstanding question and serve a different one' })
  @ApiOkResponse({ type: NextQuestionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SESSION_PAUSED · INVALID_STATE · NO_ELIGIBLE_QUESTIONS' })
  next(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query('skip') skip?: string,
  ): Promise<NextQuestionDto> {
    return this.practice.nextQuestion(auth, id, { skip: skip === 'true' || skip === '1' });
  }

  @Post('attempts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit an answer',
    description:
      'Correctness is decided here from the answer key — never from the request. The attempt row is immutable, records the difficulty and θ it was graded against, and the response is the first place the answer is disclosed. Retrying with the same `Idempotency-Key` returns the stored attempt (`replayed: true`) instead of grading twice.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8-128 characters, unique per attempt' })
  @ApiCreatedResponse({ type: AttemptResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE · SESSION_PAUSED' })
  submitAttempt(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: SubmitAttemptDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AttemptResultDto> {
    return this.attempts.submit(auth, dto, idempotencyKey);
  }

  @Post('sessions/:id/events')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Record focus-tracking events for a session',
    description:
      'Only the whitelisted event types are accepted, there is no free-form payload, and the whole feature is refused (409) when focus tracking is off for the organisation or the student has opted out. Replayed batches are ignored by client event id.',
  })
  @ApiOkResponse({ type: SessionEventsResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Focus tracking disabled' })
  recordEvents(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: SubmitSessionEventsDto,
  ): Promise<SessionEventsResultDto> {
    return this.practice.recordEvents(auth, id, dto);
  }

  @Post('sessions/:id/hints/reveal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reveal a hint sequentially for a currently served question',
    description: 'Returns the requested hint text and updates remaining hint count without exposing future hints or answer keys.',
  })
  @ApiOkResponse({ type: RevealedHintDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE' })
  revealHint(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: RevealHintDto,
  ): Promise<RevealedHintDto> {
    return this.practice.revealHint(auth, id, dto);
  }

  @Post('sessions/:id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish a session (any outstanding question is marked abandoned, never wrong)' })
  @ApiOkResponse({ type: PracticeSessionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE' })
  endSession(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: EndSessionDto): Promise<PracticeSessionDto> {
    return this.practice.endSession(auth, id, dto);
  }
}
