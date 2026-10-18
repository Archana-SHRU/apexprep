import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LearnerTracksController } from './learner-tracks.controller';
import { LearnerTracksRepository } from './learner-tracks.repository';
import { LearnerTracksService } from './learner-tracks.service';

/**
 * A learner's enrolment in one or more tracks (migration 0013).
 *
 * Imports nothing from `UsersModule` on purpose: `UsersModule` imports the repository from here so
 * that a profile update which sets `primaryTrackId` keeps the enrolment in step, and a dependency in
 * both directions would be a cycle. The repository owns the single column of `users` that the
 * primary-track invariant spans, and reads nothing else about a user.
 */
@Module({
  imports: [AuditModule],
  controllers: [LearnerTracksController],
  providers: [LearnerTracksRepository, LearnerTracksService],
  exports: [LearnerTracksRepository, LearnerTracksService],
})
export class LearnerTracksModule {}
