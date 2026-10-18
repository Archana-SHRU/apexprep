import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { MockTestsService } from './mock-tests.service';
import {
  FocusTestItemDto,
  MockTestDetailDto,
  MockTestSummaryDto,
  SessionClockDto,
  SubmitTestAnswerDto,
  TestResultDto,
  TestSessionStateDto,
} from './dto/mock-tests.dto';
import type { TestKind } from '../database/schema';

const uuid = new ParseUUIDPipe();

@ApiTags('tests')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('tests')
@RequirePermissions('practice:use')
export class MockTestsController {
  constructor(private readonly mockTests: MockTestsService) {}

  @Get()
  @ApiOperation({
    summary: 'List available mock tests',
    description: 'Returns published full-length and sectional test papers with previous attempt history.',
  })
  @ApiQuery({ name: 'kind', required: false, enum: ['full_length', 'sectional'] })
  @ApiOkResponse({ type: [MockTestSummaryDto] })
  listTests(
    @CurrentAuth() auth: AuthContext,
    @Query('kind') kind?: TestKind,
  ): Promise<MockTestSummaryDto[]> {
    return this.mockTests.listTests(auth.tenantId, auth.userId, kind);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get mock test details and section breakdown',
    description: 'Returns test metadata, section list, total marks, and learner attempt history.',
  })
  @ApiOkResponse({ type: MockTestDetailDto })
  getTest(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) testId: string,
  ): Promise<MockTestDetailDto> {
    return this.mockTests.getTestDetail(auth.tenantId, testId, auth.userId);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start or resume a timed test session',
    description:
      'Creates a new timed session (or resumes an existing open session). Returns questions with sanitized options without leaking answer keys.',
  })
  @ApiOkResponse({ type: TestSessionStateDto })
  startTest(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) testId: string,
  ): Promise<TestSessionStateDto> {
    return this.mockTests.startOrResumeTest(auth.tenantId, auth.userId, testId);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({
    summary: 'Get test session state',
    description: 'Retrieves current active exam state, remaining countdown, and saved answers.',
  })
  @ApiOkResponse({ type: TestSessionStateDto })
  getSession(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', uuid) sessionId: string,
  ): Promise<TestSessionStateDto> {
    return this.mockTests.getSessionState(auth.tenantId, auth.userId, sessionId);
  }

  @Post('sessions/:sessionId/answer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Save an answer to a question in an active test session',
    description: 'Saves candidate response and question status in the palette.',
  })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SESSION_CLOSED or TIME_EXPIRED' })
  @ApiOkResponse({ type: SessionClockDto })
  saveAnswer(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', uuid) sessionId: string,
    @Body() dto: SubmitTestAnswerDto,
  ): Promise<SessionClockDto> {
    return this.mockTests.saveAnswer(auth.tenantId, auth.userId, sessionId, dto);
  }

  @Post('sessions/:sessionId/focus')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record which question is open',
    description:
      'Call whenever the student opens a question (or with null when none is open). The server adds up how long the previous question was open, ' +
      'so time spent is measured by the server, never reported by the client. Opening a question marks it visited even if nothing is answered.',
  })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SESSION_CLOSED or TIME_EXPIRED' })
  @ApiOkResponse({ type: SessionClockDto })
  focus(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', uuid) sessionId: string,
    @Body() dto: FocusTestItemDto,
  ): Promise<SessionClockDto> {
    return this.mockTests.focus(auth.tenantId, auth.userId, sessionId, dto.testItemId);
  }

  @Post('sessions/:sessionId/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit test paper and grade results',
    description:
      'Performs server-side grading with positive/negative marks (+4/-1) and generates complete test analysis.',
  })
  @ApiOkResponse({ type: TestResultDto })
  submitTest(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', uuid) sessionId: string,
  ): Promise<TestResultDto> {
    return this.mockTests.submitTest(auth.tenantId, auth.userId, sessionId);
  }

  @Get('sessions/:sessionId/result')
  @ApiOperation({
    summary: 'Get post-test analysis and solutions',
    description:
      'Returns overall score, sectional performance, and item-by-item comparison with official solutions. ' +
      'Only available once the session is closed (submitted or timed out); before that it is refused, because it contains the answer key.',
  })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE — the test is still in progress' })
  @ApiOkResponse({ type: TestResultDto })
  getResult(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', uuid) sessionId: string,
  ): Promise<TestResultDto> {
    return this.mockTests.getResult(auth.tenantId, auth.userId, sessionId);
  }
}
