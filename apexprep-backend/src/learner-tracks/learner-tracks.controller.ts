import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { EnrolTrackDto, LearnerTrackDto, UpdateEnrolmentDto } from './dto/learner-tracks.dto';
import { LearnerTracksService } from './learner-tracks.service';

/**
 * The learner's own tracks. `self:profile` throughout — this is a learner managing their own
 * profile, and a new permission would have meant editing the role map for no new kind of access.
 *
 * Addressed by **track id**, not by enrolment id: a learner has at most one enrolment per track, so
 * the track is the natural key and the frontend never has to hold an enrolment id to change one.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/tracks')
export class LearnerTracksController {
  constructor(private readonly learnerTracks: LearnerTracksService) {}

  @Get()
  @RequirePermissions('self:profile')
  @ApiOperation({
    summary: 'The tracks you are learning in',
    description:
      'Primary track first, then most recently enrolled. Tracks you have left are included with status `left`, ' +
      'so a learner can see and rejoin them. Each entry carries the track itself, including its learning ' +
      'context — `kind`, `gradeLabel`, `gradeOrdinal` and the rest, any of which may be null on a track that ' +
      'has not been categorised.',
  })
  @ApiOkResponse({ type: [LearnerTrackDto] })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Not a student account' })
  list(@CurrentAuth() auth: AuthContext): Promise<LearnerTrackDto[]> {
    return this.learnerTracks.list(auth);
  }

  @Post()
  @RequirePermissions('self:profile')
  @ApiOperation({
    summary: 'Enrol in a track',
    description:
      'Enrolling in a track you have left reactivates that enrolment rather than starting a second one, so your ' +
      'history is kept. The first track you enrol in becomes your primary track. Enrolment records what you are ' +
      'working on; it does not change which sub-topics you may practise, which follows the published syllabus.',
  })
  @ApiCreatedResponse({ type: LearnerTrackDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'REFERENCE_NOT_FOUND (unknown or unpublished track)' })
  enrol(@CurrentAuth() auth: AuthContext, @Body() dto: EnrolTrackDto): Promise<LearnerTrackDto> {
    return this.learnerTracks.enrol(auth, dto);
  }

  @Patch(':trackId')
  @RequirePermissions('self:profile')
  @ApiOperation({
    summary: 'Make a track primary, or change your goal for it',
    description:
      'Sending `isPrimary: true` moves the primary track here and keeps your profile’s `primaryTrackId` in step. ' +
      'There is no way to ask for "not primary": make another track primary, or leave this one.',
  })
  @ApiOkResponse({ type: LearnerTrackDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'You are not enrolled in that track' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE (you have left that track)' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('trackId', ParseUUIDPipe) trackId: string,
    @Body() dto: UpdateEnrolmentDto,
  ): Promise<LearnerTrackDto> {
    return this.learnerTracks.update(auth, trackId, dto);
  }

  @Delete(':trackId')
  @RequirePermissions('self:profile')
  @ApiOperation({
    summary: 'Leave a track',
    description:
      'The enrolment is kept with status `left` so you can see and rejoin it, and none of your progress in that ' +
      'track is deleted — mastery is recorded per sub-topic and is untouched. Leaving your primary track leaves ' +
      'you with no primary track; nothing is chosen in its place.',
  })
  @ApiOkResponse({ type: LearnerTrackDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'You are not enrolled in that track' })
  leave(@CurrentAuth() auth: AuthContext, @Param('trackId', ParseUUIDPipe) trackId: string): Promise<LearnerTrackDto> {
    return this.learnerTracks.leave(auth, trackId);
  }
}
