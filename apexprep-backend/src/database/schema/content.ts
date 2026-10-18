import { bigint, integer, jsonb, numeric, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Mirror of migration 0003: uploaded assets, ingestion jobs, extracted pages and content blocks.
 *
 * Two generated columns are deliberately not mirrored — `content_blocks.search_tsv` and
 * `extracted_pages.char_count`. Drizzle never writes them, the database computes them, and the
 * schema-drift test skips generated columns for exactly this reason. SQL that needs `search_tsv`
 * references it through an `sql` template instead.
 */

export const ASSET_KINDS = ['source_pdf', 'page_image', 'figure', 'report_pdf', 'generated_visual'] as const;
export const ASSET_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const ASSET_VALIDATION_STATUSES = ['pending', 'valid', 'invalid'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetMimeType = (typeof ASSET_MIME_TYPES)[number];

/** Every stage `ingestion_jobs.status` can be in; the CHECK in migration 0003 is the authority. */
export const JOB_STATUSES = [
  'queued',
  'extracting',
  'ocr',
  'segmenting',
  'classifying',
  'tagging',
  'normalizing',
  'matching',
  'deduplicating',
  'awaiting_review',
  'publishing',
  'published',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PAGE_METHODS = ['text_layer', 'ocr'] as const;
export type PageMethod = (typeof PAGE_METHODS)[number];

export const contentAssets = pgTable('content_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ASSET_KINDS }).notNull(),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename'),
  mimeType: text('mime_type', { enum: ASSET_MIME_TYPES }).notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  pageCount: integer('page_count'),
  parentAssetId: uuid('parent_asset_id'),
  sourcePage: integer('source_page'),
  trackId: uuid('track_id'),
  subjectId: uuid('subject_id'),
  uploadedBy: uuid('uploaded_by'),
  validationStatus: text('validation_status', { enum: ASSET_VALIDATION_STATUSES }).notNull().default('pending'),
  validationError: text('validation_error'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export const ingestionJobs = pgTable('ingestion_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  requestedBy: uuid('requested_by'),
  status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
  progressPct: smallint('progress_pct').notNull().default(0),
  attemptCount: smallint('attempt_count').notNull().default(0),
  queueJobId: text('queue_job_id'),
  pagesTotal: integer('pages_total').notNull().default(0),
  pagesOcr: integer('pages_ocr').notNull().default(0),
  blocksTheory: integer('blocks_theory').notNull().default(0),
  blocksQuestion: integer('blocks_question').notNull().default(0),
  blocksSolution: integer('blocks_solution').notNull().default(0),
  blocksAmbiguous: integer('blocks_ambiguous').notNull().default(0),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: tstz('started_at'),
  finishedAt: tstz('finished_at'),
  /** Migration 0016: what syllabus-hierarchy detection found for the whole upload. */
  hierarchy: jsonb('hierarchy').$type<Record<string, unknown>>(),
  /** Migration 0019: the worker that holds the job and until when; a lapsed lease means the worker died. */
  lockedBy: text('locked_by'),
  lockedUntil: tstz('locked_until'),
  maxAttempts: smallint('max_attempts').notNull().default(3),
  nextAttemptAt: tstz('next_attempt_at'),
  ...timestamps,
});

export const extractedPages = pgTable('extracted_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  pageNumber: integer('page_number').notNull(),
  method: text('method', { enum: PAGE_METHODS }).notNull(),
  textContent: text('text_content').notNull().default(''),
  ocrConfidence: numeric('ocr_confidence', { precision: 4, scale: 3, mode: 'number' }),
  imageAssetId: uuid('image_asset_id'),
  ...timestamps,
});

export type ContentAssetRow = typeof contentAssets.$inferSelect;
export type IngestionJobRow = typeof ingestionJobs.$inferSelect;
export type ExtractedPageRow = typeof extractedPages.$inferSelect;

export const BLOCK_KINDS = ['theory', 'question', 'solution', 'ambiguous'] as const;
export const BLOCK_FORMATS = ['heading', 'paragraph', 'formula', 'callout', 'list', 'table', 'figure', 'example'] as const;
export const BLOCK_STATUSES = ['extracted', 'needs_review', 'approved', 'rejected', 'published', 'superseded'] as const;
export type BlockFormat = (typeof BLOCK_FORMATS)[number];
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

export const contentBlocks = pgTable('content_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id'),
  pageId: uuid('page_id'),
  assetId: uuid('asset_id'),
  sourcePage: integer('source_page'),
  bbox: jsonb('bbox'),
  kind: text('kind', { enum: BLOCK_KINDS }).notNull(),
  format: text('format', { enum: BLOCK_FORMATS }).notNull().default('paragraph'),
  title: text('title'),
  rawText: text('raw_text').notNull(),
  normalizedText: text('normalized_text'),
  contentJson: jsonb('content_json'),
  contentHash: text('content_hash').notNull(),
  classificationConfidence: numeric('classification_confidence', { precision: 4, scale: 3, mode: 'number' }),
  classifiedBy: text('classified_by', { enum: ['model', 'rule', 'human'] }),
  subtopicId: uuid('subtopic_id'),
  taggingConfidence: numeric('tagging_confidence', { precision: 4, scale: 3, mode: 'number' }),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: BLOCK_STATUSES }).notNull().default('extracted'),
  mergedIntoId: uuid('merged_into_id'),
  splitFromId: uuid('split_from_id'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: tstz('reviewed_at'),
  publishedAt: tstz('published_at'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export type ContentBlockRow = typeof contentBlocks.$inferSelect;
