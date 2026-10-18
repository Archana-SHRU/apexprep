import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  ChapterDetailDto,
  SubjectDetailDto,
  SubtopicDetailDto,
  TopicDetailDto,
  TrackDto,
  TrackListDto,
  TrackTreeDto,
} from './dto/syllabus.dto';
import { TheoryDto } from './dto/theory.dto';
import { SyllabusService } from './syllabus.service';

const uuid = new ParseUUIDPipe();

/**
 * The published syllabus as students see it. A node is visible only when it and all its
 * ancestors are published; anything else answers 404. Admins calling these routes see the
 * same student view (use /v1/admin/... for drafts).
 */
@ApiTags('syllabus')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
@RequirePermissions('syllabus:read')
export class SyllabusController {
  constructor(private readonly syllabus: SyllabusService) {}

  @Get('tracks')
  @ApiOperation({ summary: 'Published tracks of your organisation, with their subjects' })
  @ApiOkResponse({ type: TrackListDto })
  listTracks(@CurrentAuth() auth: AuthContext): Promise<TrackListDto> {
    return this.syllabus.listTracks(auth.tenantId, 'published');
  }

  @Get('tracks/:trackId')
  @ApiOperation({ summary: 'One published track' })
  @ApiOkResponse({ type: TrackDto })
  getTrack(@CurrentAuth() auth: AuthContext, @Param('trackId', uuid) trackId: string): Promise<TrackDto> {
    return this.syllabus.getTrack(auth.tenantId, trackId, 'published');
  }

  @Get('tracks/:trackId/tree')
  @ApiOperation({
    summary: 'Whole syllabus of a track: subjects → chapters → topics → sub-topics',
    description: 'One request for the Learn pages. `questionCount` counts published questions and rolls up; `mastery` is null until analytics are implemented.',
  })
  @ApiOkResponse({ type: TrackTreeDto })
  getTree(@CurrentAuth() auth: AuthContext, @Param('trackId', uuid) trackId: string): Promise<TrackTreeDto> {
    return this.syllabus.getTree(auth.tenantId, trackId, 'published');
  }

  @Get('subjects/:id')
  @ApiOperation({ summary: 'A subject with its chapters, topics and sub-topics, plus breadcrumbs' })
  @ApiOkResponse({ type: SubjectDetailDto })
  getSubject(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<SubjectDetailDto> {
    return this.syllabus.getSubject(auth.tenantId, id, 'published');
  }

  @Get('chapters/:id')
  @ApiOperation({ summary: 'A chapter with its topics and sub-topics, plus breadcrumbs' })
  @ApiOkResponse({ type: ChapterDetailDto })
  getChapter(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ChapterDetailDto> {
    return this.syllabus.getChapter(auth.tenantId, id, 'published');
  }

  @Get('topics/:id')
  @ApiOperation({ summary: 'A topic with its sub-topics, plus breadcrumbs' })
  @ApiOkResponse({ type: TopicDetailDto })
  getTopic(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<TopicDetailDto> {
    return this.syllabus.getTopic(auth.tenantId, id, 'published');
  }

  @Get('subtopics/:id')
  @ApiOperation({ summary: 'A sub-topic with breadcrumbs' })
  @ApiOkResponse({ type: SubtopicDetailDto })
  getSubtopic(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<SubtopicDetailDto> {
    return this.syllabus.getSubtopic(auth.tenantId, id, 'published');
  }

  @Get('subtopics/:id/theory')
  @ApiOperation({
    summary: 'Published theory of a sub-topic, in reading order',
    description: 'Theory is addressed by sub-topic. `blocks` is empty when nothing is published yet.',
  })
  @ApiOkResponse({ type: TheoryDto })
  getTheory(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<TheoryDto> {
    return this.syllabus.getTheory(auth.tenantId, id);
  }
}
