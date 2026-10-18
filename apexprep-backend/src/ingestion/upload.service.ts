import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import type { Env } from '../config/env.schema';
import { DRIZZLE, type Database } from '../database/database.module';
import { isUniqueViolation } from '../database/pg-error';
import { PdfDocument } from '../pdf/pdf-document';
import { SyllabusRepository } from '../syllabus/syllabus.repository';
import { buildAssetKey, OBJECT_STORAGE, sha256Hex, type ObjectStorage } from '../storage/object-storage';
import { IngestionRepository } from './ingestion.repository';
import { JOB_QUEUE, type JobQueue } from './job-queue';

export interface UploadInput {
  filename: string | null;
  mimeType: string | null;
  body: Buffer;
  trackId?: string | null;
  subjectId?: string | null;
  /** A free-text hint from the uploader, kept for the reviewer. */
  hint?: string | null;
}

export interface UploadResult {
  assetId: string;
  jobId: string;
  sha256: string;
  pageCount: number;
  byteSize: number;
  storageKey: string;
  queueJobId: string;
}

/**
 * Accepting a source PDF.
 *
 * The order of checks is the point of this service. Everything cheap and local happens before the
 * bytes are stored, and the bytes are stored before any row is written:
 *
 *   1. **size**, from the buffer length — no point parsing 200 MB to reject it;
 *   2. **type**, from the declared MIME type *and* the file's own header, because a client's
 *      `Content-Type` is a claim, not evidence;
 *   3. **structure** — encryption and page count, parsed locally;
 *   4. **SHA-256 duplicate**, checked against the tenant's own assets;
 *   5. **store the object**, then
 *   6. **write the asset and job rows** in one transaction.
 *
 * If the transaction fails the stored object is removed, so a rejected upload does not leave
 * bytes behind with no row pointing at them. The reverse — a row with no bytes — is the one that
 * must never happen, which is why the object is written first.
 */
@Injectable()
export class UploadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly repo: IngestionRepository,
    private readonly syllabus: SyllabusRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async upload(auth: AuthContext, input: UploadInput): Promise<UploadResult> {
    const maxBytes = this.config.get('UPLOAD_MAX_MB', { infer: true }) * 1024 * 1024;
    const maxPages = this.config.get('UPLOAD_MAX_PAGES', { infer: true });

    if (input.body.byteLength === 0) throw AppException.validation([{ field: 'file', message: 'the uploaded file is empty' }]);
    if (input.body.byteLength > maxBytes) {
      throw new AppException(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', `the file is larger than the ${maxBytes / (1024 * 1024)} MB limit`, [
        { field: 'file', message: `${input.body.byteLength} bytes exceeds ${maxBytes}` },
      ]);
    }
    if (input.mimeType !== null && input.mimeType !== 'application/pdf') {
      throw AppException.validation([{ field: 'file', message: `only application/pdf is accepted, not ${input.mimeType}` }]);
    }

    // The file's own bytes decide what it is. A .pdf name and a PDF Content-Type prove nothing.
    const pdf = PdfDocument.parse(input.body);
    const validation = pdf.validate(maxPages);
    if (!validation.ok) {
      const detail = [{ field: 'file', message: validation.message ?? 'the PDF could not be validated' }];
      // A page-count refusal is about size, an encrypted or malformed file is about content.
      throw validation.code === 'too_many_pages'
        ? new AppException(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', validation.message ?? 'too many pages', detail)
        : AppException.validation(detail);
    }

    await this.requireHints(auth, input.trackId ?? null, input.subjectId ?? null);

    const sha256 = sha256Hex(input.body);
    const existing = await this.repo.findAssetBySha(auth.tenantId, sha256);
    if (existing) {
      throw AppException.conflict(
        `this PDF has already been uploaded (asset ${existing.id}, ${existing.originalFilename ?? 'unnamed'})`,
        'DUPLICATE',
      );
    }

    const storageKey = buildAssetKey({ tenantId: auth.tenantId, kind: 'source_pdf', filename: input.filename });
    await this.storage.put({
      key: storageKey,
      body: input.body,
      contentType: 'application/pdf',
      // Non-secret annotations, so an object can be traced back without the database.
      metadata: { tenantId: auth.tenantId, sha256, uploadedBy: auth.userId },
    });

    try {
      const result = await this.db.transaction(async (tx) => {
        const asset = await this.repo.insertAsset(
          {
            tenantId: auth.tenantId,
            kind: 'source_pdf',
            storageKey,
            // Kept verbatim as metadata, never used to build a path.
            originalFilename: input.filename?.slice(0, 255) ?? null,
            mimeType: 'application/pdf',
            byteSize: input.body.byteLength,
            sha256,
            pageCount: validation.pageCount,
            trackId: input.trackId ?? null,
            subjectId: input.subjectId ?? null,
            uploadedBy: auth.userId,
            validationStatus: 'valid',
          },
          tx,
        );
        const job = await this.repo.insertJob(
          { tenantId: auth.tenantId, assetId: asset.id, requestedBy: auth.userId, status: 'queued', pagesTotal: validation.pageCount },
          tx,
        );
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            // Named explicitly: the upload is read from the raw socket, where the request's context can be lost, and
            // an upload recorded as the system would hide who put the file there.
            actor: auth,
            action: 'content_asset.uploaded',
            entityType: 'content_asset',
            entityId: asset.id,
            after: {
              filename: asset.originalFilename,
              byteSize: asset.byteSize,
              sha256,
              pageCount: validation.pageCount,
              pdfVersion: validation.version,
              storageKey,
              storageDriver: this.storage.driver,
              jobId: job.id,
              trackId: asset.trackId,
              subjectId: asset.subjectId,
              hint: input.hint ?? null,
            },
          },
          tx,
        );
        return { asset, job };
      });

      // Queued after the commit: a job that referenced an uncommitted row could be picked up
      // before it exists.
      const queueJobId = await this.queue.enqueue({ jobId: result.job.id, tenantId: auth.tenantId, attempt: 1 });
      await this.repo.updateJob(auth.tenantId, result.job.id, { queueJobId });

      return {
        assetId: result.asset.id,
        jobId: result.job.id,
        sha256,
        pageCount: validation.pageCount,
        byteSize: result.asset.byteSize,
        storageKey,
        queueJobId,
      };
    } catch (error) {
      // Nothing points at these bytes, so they are removed rather than left orphaned.
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isUniqueViolation(error)) {
        throw AppException.conflict('this PDF has already been uploaded', 'DUPLICATE');
      }
      throw error;
    }
  }

  /** The track and subject hints must exist in this organisation and belong together. */
  private async requireHints(auth: AuthContext, trackId: string | null, subjectId: string | null): Promise<void> {
    if (trackId) {
      const track = await this.syllabus.ancestry('track', auth.tenantId, trackId, 'all');
      if (!track) throw AppException.validation([{ field: 'trackId', message: 'no such track in this organisation' }]);
    }
    if (subjectId) {
      const subject = await this.syllabus.ancestry('subject', auth.tenantId, subjectId, 'all');
      if (!subject) throw AppException.validation([{ field: 'subjectId', message: 'no such subject in this organisation' }]);
      if (trackId && subject.track?.id !== trackId) {
        throw AppException.validation([{ field: 'subjectId', message: 'the subject does not belong to the track given' }]);
      }
    }
  }
}
