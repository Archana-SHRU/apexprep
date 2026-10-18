import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { EngineConfigModule } from '../engine-config/engine-config.module';
import { PracticeModule } from '../practice/practice.module';
import { QuestionsModule } from '../questions/questions.module';
import { ExplanationsAdminController, ExplanationsController } from './explanations.controller';
import { ExplanationsRepository } from './explanations.repository';
import { ExplanationsService } from './explanations.service';
import { TheoryRetrievalService } from './theory-retrieval.service';

/**
 * The explanation system.
 *
 * It imports `PracticeModule` for one reason worth naming: the answer key it validates a
 * generated explanation against is read through `PracticeRepository`, so the safety check runs
 * on exactly the record students are graded from rather than a second copy of the answer.
 */
@Module({
  imports: [AiModule, QuestionsModule, PracticeModule, EngineConfigModule, AuditModule],
  controllers: [ExplanationsController, ExplanationsAdminController],
  providers: [ExplanationsRepository, ExplanationsService, TheoryRetrievalService],
  // The repository and retrieval are exported for the learning-AI features, which ground their output
  // in the same theory through the same rules rather than a second implementation.
  exports: [ExplanationsService, ExplanationsRepository, TheoryRetrievalService],
})
export class ExplanationsModule {}
