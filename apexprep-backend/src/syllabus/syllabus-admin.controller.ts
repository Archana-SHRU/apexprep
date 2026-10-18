import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
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
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  ChapterDto,
  CreateChapterDto,
  CreateSubjectDto,
  CreateSubtopicDto,
  CreateTopicDto,
  CreateTrackDto,
  SubjectDto,
  SubtopicDto,
  TopicDto,
  TrackDto,
  TrackListDto,
  TrackTreeDto,
  UpdateChapterDto,
  UpdateSubjectDto,
  UpdateSubtopicDto,
  UpdateTopicDto,
  UpdateTrackDto,
} from './dto/syllabus.dto';
import { AdminTheoryBlockDto, AdminTheoryBlockListDto, CreateTheoryBlockDto, UpdateTheoryBlockDto } from './dto/theory.dto';
import { SyllabusAdminService } from './syllabus-admin.service';
import { SyllabusService } from './syllabus.service';
import { TheoryAdminService } from './theory-admin.service';

const uuid = new ParseUUIDPipe();

/**
 * Syllabus and theory authoring for content admins (`content:manage`). Everything is
 * scoped to the admin's organisation and audited. Deletes are soft.
 */
@ApiTags('admin: syllabus')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('admin')
@RequirePermissions('content:manage')
export class SyllabusAdminController {
  constructor(
    private readonly syllabus: SyllabusService,
    private readonly admin: SyllabusAdminService,
    private readonly theory: TheoryAdminService,
  ) {}

  // ------------------------------------------------------------ reads (all statuses)

  @Get('tracks')
  @ApiOperation({ summary: 'All tracks in your organisation, any status' })
  @ApiOkResponse({ type: TrackListDto })
  listTracks(@CurrentAuth() auth: AuthContext): Promise<TrackListDto> {
    return this.syllabus.listTracks(auth.tenantId, 'all');
  }

  @Get('tracks/:trackId/tree')
  @ApiOperation({ summary: 'Full tree of a track including draft and archived nodes' })
  @ApiOkResponse({ type: TrackTreeDto })
  tree(@CurrentAuth() auth: AuthContext, @Param('trackId', uuid) trackId: string): Promise<TrackTreeDto> {
    return this.syllabus.getTree(auth.tenantId, trackId, 'all');
  }

  // ------------------------------------------------------------ tracks

  @Post('tracks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a track (draft unless status is given)' })
  @ApiCreatedResponse({ type: TrackDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  createTrack(@CurrentAuth() auth: AuthContext, @Body() dto: CreateTrackDto): Promise<TrackDto> {
    return this.admin.createTrack(auth, dto);
  }

  @Patch('tracks/:id')
  @ApiOperation({ summary: 'Update a track' })
  @ApiOkResponse({ type: TrackDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  updateTrack(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateTrackDto): Promise<TrackDto> {
    return this.admin.updateTrack(auth, id, dto);
  }

  @Delete('tracks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a track (soft). Refused while it has subjects.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'NODE_NOT_EMPTY' })
  deleteTrack(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.deleteTrack(auth, id);
  }

  // ------------------------------------------------------------ subjects

  @Post('tracks/:trackId/subjects')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a subject in a track' })
  @ApiCreatedResponse({ type: SubjectDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  createSubject(@CurrentAuth() auth: AuthContext, @Param('trackId', uuid) trackId: string, @Body() dto: CreateSubjectDto): Promise<SubjectDto> {
    return this.admin.createSubject(auth, trackId, dto);
  }

  @Patch('subjects/:id')
  @ApiOperation({ summary: 'Update a subject' })
  @ApiOkResponse({ type: SubjectDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  updateSubject(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateSubjectDto): Promise<SubjectDto> {
    return this.admin.updateSubject(auth, id, dto);
  }

  @Delete('subjects/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a subject (soft). Refused while it has chapters.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'NODE_NOT_EMPTY' })
  deleteSubject(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.deleteSubject(auth, id);
  }

  // ------------------------------------------------------------ chapters

  @Post('subjects/:subjectId/chapters')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a chapter in a subject' })
  @ApiCreatedResponse({ type: ChapterDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  createChapter(@CurrentAuth() auth: AuthContext, @Param('subjectId', uuid) subjectId: string, @Body() dto: CreateChapterDto): Promise<ChapterDto> {
    return this.admin.createChapter(auth, subjectId, dto);
  }

  @Patch('chapters/:id')
  @ApiOperation({ summary: 'Update a chapter' })
  @ApiOkResponse({ type: ChapterDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  updateChapter(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateChapterDto): Promise<ChapterDto> {
    return this.admin.updateChapter(auth, id, dto);
  }

  @Delete('chapters/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a chapter (soft). Refused while it has topics.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'NODE_NOT_EMPTY' })
  deleteChapter(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.deleteChapter(auth, id);
  }

  // ------------------------------------------------------------ topics

  @Post('chapters/:chapterId/topics')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a topic in a chapter' })
  @ApiCreatedResponse({ type: TopicDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  createTopic(@CurrentAuth() auth: AuthContext, @Param('chapterId', uuid) chapterId: string, @Body() dto: CreateTopicDto): Promise<TopicDto> {
    return this.admin.createTopic(auth, chapterId, dto);
  }

  @Patch('topics/:id')
  @ApiOperation({ summary: 'Update a topic' })
  @ApiOkResponse({ type: TopicDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  updateTopic(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateTopicDto): Promise<TopicDto> {
    return this.admin.updateTopic(auth, id, dto);
  }

  @Delete('topics/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a topic (soft). Refused while it has sub-topics.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'NODE_NOT_EMPTY' })
  deleteTopic(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.deleteTopic(auth, id);
  }

  // ------------------------------------------------------------ sub-topics

  @Post('topics/:topicId/subtopics')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a sub-topic in a topic' })
  @ApiCreatedResponse({ type: SubtopicDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  createSubtopic(@CurrentAuth() auth: AuthContext, @Param('topicId', uuid) topicId: string, @Body() dto: CreateSubtopicDto): Promise<SubtopicDto> {
    return this.admin.createSubtopic(auth, topicId, dto);
  }

  @Patch('subtopics/:id')
  @ApiOperation({ summary: 'Update a sub-topic' })
  @ApiOkResponse({ type: SubtopicDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  updateSubtopic(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateSubtopicDto): Promise<SubtopicDto> {
    return this.admin.updateSubtopic(auth, id, dto);
  }

  @Delete('subtopics/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a sub-topic (soft). Refused while it has questions or content blocks.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'NODE_NOT_EMPTY' })
  deleteSubtopic(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.admin.deleteSubtopic(auth, id);
  }

  // ------------------------------------------------------------ theory blocks

  @Get('subtopics/:subtopicId/theory-blocks')
  @ApiOperation({ summary: 'Theory blocks of a sub-topic, published and unpublished' })
  @ApiOkResponse({ type: AdminTheoryBlockListDto })
  listTheory(@CurrentAuth() auth: AuthContext, @Param('subtopicId', uuid) subtopicId: string): Promise<AdminTheoryBlockListDto> {
    return this.theory.list(auth, subtopicId);
  }

  @Post('subtopics/:subtopicId/theory-blocks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a theory block (unpublished unless publish: true)' })
  @ApiCreatedResponse({ type: AdminTheoryBlockDto })
  createTheory(
    @CurrentAuth() auth: AuthContext,
    @Param('subtopicId', uuid) subtopicId: string,
    @Body() dto: CreateTheoryBlockDto,
  ): Promise<AdminTheoryBlockDto> {
    return this.theory.create(auth, subtopicId, dto);
  }

  @Patch('theory-blocks/:id')
  @ApiOperation({ summary: 'Edit, reorder, publish or unpublish a theory block' })
  @ApiOkResponse({ type: AdminTheoryBlockDto })
  updateTheory(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UpdateTheoryBlockDto): Promise<AdminTheoryBlockDto> {
    return this.theory.update(auth, id, dto);
  }

  @Delete('theory-blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a theory block (soft)' })
  @ApiNoContentResponse()
  deleteTheory(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    return this.theory.remove(auth, id);
  }
}
