import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthContext } from '../common/auth/auth-context';
import { AuthRateLimit, CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  ApplyDefaultsDto,
  ApprovalResultDto,
  ApproveDocumentDto,
  ApproveSuggestionDto,
  ApprovedSuggestionDto,
  BlockPatchDto,
  IngestionJobListDto,
  JobDetailDto,
  JobPreviewDto,
  ListJobsQueryDto,
  MergeBlocksDto,
  PublishBlockResultDto,
  ReclassifyBlockDto,
  RejectSuggestionDto,
  ReviewBlockDto,
  ReviewedBlockDto,
  SplitBlockDto,
  SyllabusSuggestionDto,
  SyllabusSuggestionListDto,
  UnpublishBlockDto,
  UploadAssetDto,
  UploadAssetResultDto,
} from './dto/ingestion.dto';
import { DocumentApprovalService } from './document-approval.service';
import { IngestionService } from './ingestion.service';
import { ReviewService } from './review.service';
import { SyllabusSuggestionService } from './syllabus-suggestion.service';
import { UploadService } from './upload.service';

const uuid = new ParseUUIDPipe();

/**
 * The admin side of content ingestion: upload a PDF, watch the job, review what came out of it,
 * and publish what is good.
 *
 * `content:manage` throughout — the same permission that guards authoring theory and questions by
 * hand, because this is the same act done from a document. Students have no route here at all.
 *
 * The upload route takes the raw PDF body rather than multipart: no multipart parser is installed
 * (DECISIONS.md §D), and a single-file upload does not need one — the bytes are the body, the
 * hints are query parameters. It is documented as `application/pdf` so a client sends exactly
 * that.
 */
@ApiTags('ingestion')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('admin/ingestion')
@RequirePermissions('content:manage')
export class IngestionController {
  constructor(
    private readonly upload: UploadService,
    private readonly jobs: IngestionService,
    private readonly review: ReviewService,
    private readonly syllabus: SyllabusSuggestionService,
    private readonly documents: DocumentApprovalService,
  ) {}

  // ---------------------------------------------------------------- upload

  @Post('assets')
  @HttpCode(HttpStatus.CREATED)
  // Uploads are expensive: they hit storage and start a job. The stricter bucket applies.
  @AuthRateLimit()
  @ApiConsumes('application/pdf')
  @ApiBody({ description: 'The PDF itself, as the raw request body.', schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary: 'Upload a source PDF and start an ingestion job',
    description:
      'Checks the size, then the type from the file\'s own header rather than the declared one, then encryption and the page count, then the SHA-256 against this organisation\'s assets. ' +
      'The bytes are stored before any row is written, and removed again if the row cannot be written. Returns as soon as the job is queued; it runs in the background.',
  })
  @ApiCreatedResponse({ type: UploadAssetResultDto })
  @ApiPayloadTooLargeResponse({ type: ErrorResponseDto, description: 'Over the size limit, or more pages than the configured maximum' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'DUPLICATE — this exact PDF has already been uploaded' })
  async uploadAsset(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Query() query: UploadAssetDto,
  ): Promise<UploadAssetResultDto> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    return this.upload.upload(auth, {
      body,
      filename: filenameFrom(request),
      mimeType: request.headers['content-type'] ?? null,
      trackId: query.trackId ?? null,
      subjectId: query.subjectId ?? null,
      hint: query.hint ?? null,
    });
  }

  // ---------------------------------------------------------------- jobs

  @Get('jobs')
  @ApiOperation({ summary: "This organisation's ingestion jobs, newest first" })
  @ApiOkResponse({ type: IngestionJobListDto })
  listJobs(@CurrentAuth() auth: AuthContext, @Query() query: ListJobsQueryDto): Promise<IngestionJobListDto> {
    return this.jobs.list(auth, query);
  }

  @Get('jobs/:id')
  @ApiOperation({
    summary: 'One job with its stage, counts, error and review tasks',
    description: 'The stage moves through the pipeline; `errorCode` is stable and `errorMessage` says what happened, so a failure is readable without the logs.',
  })
  @ApiOkResponse({ type: JobDetailDto })
  getJob(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<JobDetailDto> {
    return this.jobs.get(auth, id);
  }

  @Post('jobs/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run a job again',
    description:
      'Every stage is idempotent, so a re-run replaces this job\'s pages, machine-written blocks and machine-opened review tasks rather than adding a second set. ' +
      'Anything a reviewer has touched — edited, reclassified, merged, split, approved — is left exactly as they left it.',
  })
  @ApiOkResponse({ type: JobDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'The job is already running, or is published' })
  retryJob(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<JobDetailDto> {
    return this.jobs.retry(auth, id);
  }

  @Get('jobs/:id/blocks')
  @ApiOperation({
    summary: 'The blocks a job produced, with what the machine concluded and what is stopping each one publishing',
    description: 'Each block carries its source page and order, its confidences, the extracted question where there is one, and the failing quality gates.',
  })
  @ApiOkResponse({ type: [ReviewedBlockDto] })
  blocks(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ReviewedBlockDto[]> {
    return this.review.blocksOfJob(auth, id);
  }

  // ---------------------------------------------------------------- the whole document

  @Get('jobs/:id/preview')
  @ApiOperation({
    summary: 'The prepared document, whole: the syllabus it proposes, every block with its readiness, and what approving would do',
    description:
      'Everything the single approval needs to be an informed decision, in one response: each block with its text, its question and solution, ' +
      'where it came from (extracted, model-assisted or model-generated), whether it is ready, flagged or blocked and why, and counts. Nothing is published by reading this.',
  })
  @ApiOkResponse({ type: JobPreviewDto })
  preview(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<JobPreviewDto> {
    return this.documents.preview(auth, id);
  }

  @Post('jobs/:id/defaults')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fill the difficulty and expected time that no document states, in one go',
    description:
      "Accept the suggestions, or choose a difficulty and an expected time per question type, for every question that has none. " +
      'Values already set are never changed. This does not count as reviewing the questions.',
  })
  @ApiOkResponse({ type: Object })
  applyDefaults(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: ApplyDefaultsDto): Promise<{ updated: number; questions: number }> {
    return this.documents.applyDefaults(auth, id, dto);
  }

  @Post('jobs/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve and publish the whole document',
    description:
      'The one act that publishes ingested content. Approves the syllabus levels the document proposes, then publishes every block that is ready — ' +
      'and, with confirmFlagged, the flagged ones too, which are then recorded as reviewed by you. Blocks that are blocked are listed with the reason ' +
      'and left as they were. Everything is published through the normal publishing path under your identity; nothing is published without this call. ' +
      'Safe to repeat: published blocks are skipped. dryRun reports without changing anything.',
  })
  @ApiOkResponse({ type: ApprovalResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE — not waiting for review; CONFLICT — being approved by someone else' })
  approveDocument(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: ApproveDocumentDto): Promise<ApprovalResultDto> {
    return this.documents.approve(auth, id, dto);
  }

  // ---------------------------------------------------------------- syllabus suggestions

  @Get('jobs/:id/suggestions')
  @ApiOperation({
    summary: 'The chapter → topic → sub-topic hierarchy detected in this upload, as suggestions awaiting a decision',
    description:
      'Each suggestion shows every level as `existing` (matched in the uploaded subject), `new` (to be created on approval) or ' +
      '`unresolved` (the PDF does not state it), with the heading lines it came from. A suggestion is not a syllabus node.',
  })
  @ApiOkResponse({ type: SyllabusSuggestionListDto })
  suggestions(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<SyllabusSuggestionListDto> {
    return this.syllabus.list(auth, id);
  }

  @Post('jobs/:id/suggestions/:suggestionId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a suggested hierarchy: create the missing levels and file the waiting blocks under it',
    description:
      'In one transaction: reuses existing levels, creates only the missing ones (published, under the uploaded track and subject), ' +
      'publishes a reused draft level, sets the sub-topic of the linked blocks and closes their waiting tasks. Names may be edited; a new name ' +
      'must appear in the uploaded PDF. The blocks themselves are **not** approved or published — that is still the normal review.',
  })
  @ApiOkResponse({ type: ApprovedSuggestionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE — already decided, or the subject has gone' })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'NAME_NOT_GROUNDED — a new name is not in the PDF' })
  approveSuggestion(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('suggestionId', uuid) suggestionId: string,
    @Body() dto: ApproveSuggestionDto,
  ): Promise<ApprovedSuggestionDto> {
    return this.syllabus.approve(auth, id, suggestionId, dto);
  }

  @Post('jobs/:id/suggestions/:suggestionId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a suggested hierarchy', description: 'Creates nothing. The linked blocks stay unmapped for a person to file or reject.' })
  @ApiOkResponse({ type: SyllabusSuggestionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE — already decided' })
  rejectSuggestion(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('suggestionId', uuid) suggestionId: string,
    @Body() dto: RejectSuggestionDto,
  ): Promise<SyllabusSuggestionDto> {
    return this.syllabus.reject(auth, id, suggestionId, dto);
  }

  // ---------------------------------------------------------------- review

  @Post('blocks/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a block as it stands', description: 'Resolves the review tasks that named it. An ambiguous block must be reclassified first.' })
  @ApiOkResponse({ type: ReviewedBlockDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'NOT_PUBLISHABLE — an ambiguous block cannot be approved' })
  approve(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: ReviewBlockDto): Promise<ReviewedBlockDto> {
    return this.review.approve(auth, id, dto);
  }

  @Post('blocks/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a block',
    description: 'A reason is required. The block is kept, not deleted: the source document is evidence and a rejection can be revisited. Undoing an approval is only allowed inside the configured window.',
  })
  @ApiOkResponse({ type: ReviewedBlockDto })
  reject(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: ReviewBlockDto): Promise<ReviewedBlockDto> {
    return this.review.reject(auth, id, dto);
  }

  @Patch('blocks/:id')
  @ApiOperation({
    summary: 'Edit a block: its text, title, sub-topic or extracted question',
    description:
      'Every call is a save, so a client may PATCH as the reviewer types — there is no separate draft to lose. An edit marks the block reviewed, which is also what stops a pipeline re-run from overwriting it.',
  })
  @ApiOkResponse({ type: ReviewedBlockDto })
  edit(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: BlockPatchDto): Promise<ReviewedBlockDto> {
    return this.review.edit(auth, id, dto);
  }

  @Post('blocks/:id/reclassify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Say what a block actually is', description: 'The way an ambiguous block becomes usable. Sets the classification to human certainty.' })
  @ApiOkResponse({ type: ReviewedBlockDto })
  reclassify(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: ReclassifyBlockDto): Promise<ReviewedBlockDto> {
    return this.review.reclassify(auth, id, dto);
  }

  @Post('blocks/merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge blocks into the first, in reading order',
    description: 'For a question split across a page break. The sources are kept and point at the survivor, so the join is reversible and every source page stays traceable.',
  })
  @ApiOkResponse({ type: ReviewedBlockDto })
  merge(@CurrentAuth() auth: AuthContext, @Body() dto: MergeBlocksDto): Promise<ReviewedBlockDto> {
    return this.review.merge(auth, dto);
  }

  @Post('blocks/:id/split')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Split a block into pieces',
    description: 'For two questions the segmenter ran together. The original is kept as superseded and each piece records where it came from.',
  })
  @ApiCreatedResponse({ type: [ReviewedBlockDto] })
  split(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: SplitBlockDto): Promise<ReviewedBlockDto[]> {
    return this.review.split(auth, id, dto);
  }

  // ---------------------------------------------------------------- publication

  @Post('blocks/:id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a reviewed block',
    description:
      'Runs the quality gates and refuses with the list of failures when any of them fails. Theory becomes published theory; a question block becomes a real question through the question-bank service, so Phase 3 validation, its difficulty from the active engine configuration, versioning and audit all apply. A matched solution becomes the official solution.',
  })
  @ApiOkResponse({ type: PublishBlockResultDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'NOT_PUBLISHABLE — `details` lists every failing gate' })
  publish(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PublishBlockResultDto> {
    return this.review.publish(auth, id);
  }

  @Post('blocks/:id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take published content back out of circulation',
    description: 'Theory stops being served. A published question is retired rather than deleted, so the attempt history stays intact.',
  })
  @ApiOkResponse({ type: PublishBlockResultDto })
  unpublish(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body() dto: UnpublishBlockDto): Promise<PublishBlockResultDto> {
    return this.review.unpublish(auth, id, dto.note);
  }
}

/**
 * The uploaded name, from `Content-Disposition` or `X-Filename`, when a client sends one.
 *
 * It is metadata and nothing else: `content_assets.original_filename` stores it for the reviewer,
 * and the object key is built from a fresh UUID, so a hostile filename has nothing to act on.
 * Path separators are stripped anyway, because defence that costs one line is worth having.
 */
function filenameFrom(request: Request): string | null {
  const header = request.headers['x-filename'] ?? request.headers['content-disposition'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(raw);
  const name = (match?.[1] ?? raw).trim();
  const safe = Array.from(name.replace(/[\\/]/g, '_'))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
  return safe.length > 0 ? safe.slice(0, 255) : null;
}
