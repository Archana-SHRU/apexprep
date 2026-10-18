import { Module } from '@nestjs/common';
import { EngineConfigModule } from '../engine-config/engine-config.module';
import { SyllabusModule } from '../syllabus/syllabus.module';
import { DivergenceController } from './divergence.controller';
import { DivergenceService } from './divergence.service';
import { QuestionsAdminController } from './questions-admin.controller';
import { QuestionsAdminService } from './questions-admin.service';
import { QuestionsRepository } from './questions.repository';
import { QuestionsService } from './questions.service';

@Module({
  imports: [SyllabusModule, EngineConfigModule],
  controllers: [QuestionsAdminController, DivergenceController],
  providers: [QuestionsRepository, QuestionsService, QuestionsAdminService, DivergenceService],
  // QuestionsAdminService is exported so ingestion (Phase 7) creates questions through the same
  // authoring service an admin uses — the same validation, versioning, difficulty and audit rows.
  // There is deliberately no second path into the question bank.
  exports: [QuestionsRepository, QuestionsService, QuestionsAdminService, DivergenceService],
})
export class QuestionsModule {}
