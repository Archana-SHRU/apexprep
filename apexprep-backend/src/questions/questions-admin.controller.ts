import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  AdminQuestionDto,
  AdminQuestionPageDto,
  CreateQuestionDto,
  ListQuestionsQueryDto,
  OfficialSolutionDto,
  OfficialSolutionInputDto,
  StudentQuestionDto,
  UpdateQuestionDto,
} from './dto/questions.dto';
import { QuestionsAdminService } from './questions-admin.service';
import { QuestionsService } from './questions.service';

const uuid = new ParseUUIDPipe();

/**
 * Question bank authoring (`questions:manage`). Responses here include the answer key —
 * these routes are never reachable by a student, whose only view is /preview's shape.
 */
@ApiTags('admin: questions')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('admin/questions')
@RequirePermissions('questions:manage')
export class QuestionsAdminController {
  constructor(
    private readonly admin: QuestionsAdminService,
    private readonly questions: QuestionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search the question bank (newest first, cursor-paginated)' })
  @ApiOkResponse({ type: AdminQuestionPageDto })
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListQuestionsQueryDto): Promise<AdminQuestionPageDto> {
    return this.admin.list(auth, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a question (always as a draft)',
    description:
      'Answer shape is validated per type. The starting Elo difficulty comes from the active engine configuration, so the organisation needs one (409 ENGINE_CONFIG_MISSING otherwise).',
  })
  @ApiCreatedResponse({ type: AdminQuestionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'ENGINE_CONFIG_MISSING' })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateQuestionDto): Promise<AdminQuestionDto> {
    return this.admin.create(auth, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One question with its answer key and official solution' })
  @ApiOkResponse({ type: AdminQuestionDto })
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<AdminQuestionDto> {
    return this.admin.get(auth, id);
  }

  @Get(':id/preview')
  @ApiOperation({
    summary: 'Exactly what a student would receive for this question',
    description: 'The student projection: no answer key, no solution, no engine difficulty. Useful for checking a question before publishing.',
  })
  @ApiOkResponse({ type: StudentQuestionDto })
  preview(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<StudentQuestionDto> {
    return this.questions.studentView(auth.tenantId, id, true);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a question',
    description: 'Sending `options`, `numericAnswer`, `matrixAnswer` or `secondarySubtopicIds` replaces them. Content and answer edits bump the version. The type cannot change.',
  })
  @ApiOkResponse({ type: AdminQuestionDto })
  update(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateQuestionDto): Promise<AdminQuestionDto> {
    return this.admin.update(auth, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a question so the adaptive engine can serve it' })
  @ApiOkResponse({ type: AdminQuestionDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'NOT_PUBLISHABLE' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE' })
  publish(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<AdminQuestionDto> {
    return this.admin.publish(auth, id);
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retire a published question (kept for attempt history, never served again)' })
  @ApiOkResponse({ type: AdminQuestionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE' })
  retire(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<AdminQuestionDto> {
    return this.admin.retire(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a question (soft). Published questions must be retired first.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE' })
  remove(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.remove(auth, id);
  }

  @Put(':id/official-solution')
  @ApiOperation({ summary: 'Set (or replace) the official solution — the first choice for explanations' })
  @ApiOkResponse({ type: OfficialSolutionDto })
  setSolution(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: OfficialSolutionInputDto): Promise<OfficialSolutionDto> {
    return this.admin.setOfficialSolution(auth, id, dto);
  }

  @Delete(':id/official-solution')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove the official solution' })
  @ApiNoContentResponse()
  removeSolution(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.removeOfficialSolution(auth, id);
  }
}
