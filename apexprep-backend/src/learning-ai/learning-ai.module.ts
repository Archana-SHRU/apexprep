import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { EngineConfigModule } from '../engine-config/engine-config.module';
import { ExplanationsModule } from '../explanations/explanations.module';
import { PracticeModule } from '../practice/practice.module';
import { QuestionsModule } from '../questions/questions.module';
import { StorageModule } from '../storage/storage.module';
import {
  GeneratedQuestionsAdminController,
  GeneratedQuestionsController,
  RevisionNotesController,
  TutorController,
  VisualsController,
} from './learning-ai.controller';
import { LearningAiRepository } from './learning-ai.repository';
import { RevisionNotesService } from './notes/revision-notes.service';
import { QuestionGenerationService } from './questions/question-generation.service';
import { TutorService } from './tutor/tutor.service';
import { VisualExplanationService } from './visuals/visual-explanation.service';

/**
 * Revision notes, question generation, the AI tutor and visual explanations.
 *
 * Built on the existing layers rather than beside them: the provider boundary (`AiModule`), theory
 * retrieval and its grounding rules (`ExplanationsModule`), the answer key and ability records students
 * are graded from (`PracticeModule`), the question bank (`QuestionsModule`), the adaptive engine's
 * configuration (`EngineConfigModule`) and object storage (`StorageModule`).
 */
@Module({
  imports: [AiModule, AuditModule, EngineConfigModule, ExplanationsModule, PracticeModule, QuestionsModule, StorageModule],
  controllers: [RevisionNotesController, GeneratedQuestionsController, TutorController, VisualsController, GeneratedQuestionsAdminController],
  providers: [LearningAiRepository, RevisionNotesService, QuestionGenerationService, TutorService, VisualExplanationService],
})
export class LearningAiModule {}
