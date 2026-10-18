import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { EngineConfigModule } from '../engine-config/engine-config.module';
import { ExplanationsModule } from '../explanations/explanations.module';
import { PdfModule } from '../pdf/pdf.module';
import { QuestionsModule } from '../questions/questions.module';
import { StorageModule } from '../storage/storage.module';
import { SyllabusModule } from '../syllabus/syllabus.module';
import { DocumentApprovalService } from './document-approval.service';
import { IngestionController } from './ingestion.controller';
import { LearningAiRepository } from '../learning-ai/learning-ai.repository';
import { IngestionPipeline } from './ingestion.pipeline';
import { IngestionRepository } from './ingestion.repository';
import { IngestionService } from './ingestion.service';
import { LearningDraftsService } from './learning-drafts.service';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { InProcessJobQueue, JOB_QUEUE, type JobQueue } from './job-queue';
import { PostgresJobQueue } from './postgres-job-queue';
import { QuestionDraftsService } from './question-drafts.service';
import { ReviewService } from './review.service';
import { SyllabusSuggestionService } from './syllabus-suggestion.service';
import { SyllabusSuggestionsRepository } from './syllabus-suggestions.repository';
import { UploadService } from './upload.service';

/**
 * The content-ingestion pipeline: a PDF in, reviewed and published content out.
 *
 * Three imports carry the weight, and each is a deliberate reuse rather than a convenience:
 *
 *   * **QuestionsModule** — a published question block becomes a question through
 *     `QuestionsAdminService`, the same service an admin authoring by hand goes through. So Phase 3's
 *     per-type answer validation, its versioning, its starting difficulty from the active engine
 *     configuration and its audit rows all apply to ingested questions, and there is no second
 *     grading or validation model to drift.
 *   * **EngineConfigModule** — every threshold the pipeline uses (classification and mapping
 *     confidence, the near-duplicate similarity, the auto-approval rules, the approval-reversal
 *     window) is read from the tenant's active engine configuration. This module contributes no
 *     thresholds of its own.
 *   * **SyllabusModule** — mapping reads existing syllabus nodes. The pipeline itself never creates
 *     one: it writes `syllabus_suggestions`, and only an admin's approval (`SyllabusSuggestionService`)
 *     creates the missing chapter, topic or sub-topic. A model, when one is configured, may only pick
 *     among the PDF's own heading lines for a document with no numbered structure.
 *   * **ExplanationsModule** — publishing a theory block re-embeds its sub-topic through Phase 6's
 *     own indexing path, so ingested theory reaches semantic retrieval through the existing
 *     embedding abstraction rather than through a second one.
 *
 * `JOB_QUEUE` is bound here, and only here, to the PostgreSQL-backed queue (`INGESTION_QUEUE_DRIVER=postgres`, the
 * default): durable, leased and recoverable, with no Redis. `memory` selects the in-process runner. See
 * `postgres-job-queue.ts`.
 */
@Module({
  imports: [StorageModule, PdfModule, SyllabusModule, QuestionsModule, EngineConfigModule, ExplanationsModule, AuditModule, AiModule],
  controllers: [IngestionController],
  providers: [
    InProcessJobQueue,
    PostgresJobQueue,
    {
      provide: JOB_QUEUE,
      inject: [ConfigService, PostgresJobQueue, InProcessJobQueue],
      useFactory: (config: ConfigService<Env, true>, durable: PostgresJobQueue, inProcess: InProcessJobQueue): JobQueue =>
        config.get('INGESTION_QUEUE_DRIVER', { infer: true }) === 'memory' ? inProcess : durable,
    },
    IngestionRepository,
    UploadService,
    IngestionPipeline,
    LearningDraftsService,
    QuestionDraftsService,
    DocumentApprovalService,
    LearningAiRepository,
    IngestionService,
    ReviewService,
    SyllabusSuggestionsRepository,
    SyllabusSuggestionService,
  ],
  exports: [IngestionRepository, JOB_QUEUE],
})
export class IngestionModule {}
