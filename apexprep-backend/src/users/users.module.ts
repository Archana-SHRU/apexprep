import { Module } from '@nestjs/common';
import { LearnerTracksModule } from '../learner-tracks/learner-tracks.module';
import { AdminStudentsController, AdminUsersController } from './admin-users.controller';
import { MeController } from './me.controller';
import { RefreshTokensRevoker } from './refresh-tokens-revoker';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [LearnerTracksModule],
  controllers: [MeController, AdminStudentsController, AdminUsersController],
  providers: [UsersRepository, UsersService, RefreshTokensRevoker],
  exports: [UsersRepository, UsersService],
})
export class UsersModule {}
