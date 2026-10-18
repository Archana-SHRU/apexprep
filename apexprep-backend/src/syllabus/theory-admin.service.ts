import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database } from '../database/database.module';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { contentBlocks, type ContentBlockRow } from '../database/schema';
import type { AdminTheoryBlockDto, AdminTheoryBlockListDto, CreateTheoryBlockDto, UpdateTheoryBlockDto } from './dto/theory.dto';
import { SyllabusRepository } from './syllabus.repository';
import { AUTHORABLE_FORMATS, buildTheoryBlockContent, contentHash, normalizeText, renderBlock, type AuthorableFormat } from './theory-text';

function toAdminBlock(r: ContentBlockRow): AdminTheoryBlockDto {
  return {
    id: r.id,
    subtopicId: r.subtopicId!,
    type: r.format,
    title: r.title,
    ...renderBlock(r.format, r.normalizedText ?? r.rawText, r.contentJson),
    sortOrder: r.sortOrder,
    status: r.status,
    contentHash: r.contentHash,
    sourceAssetId: r.assetId,
    sourcePage: r.sourcePage,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function isAuthorable(format: string): format is AuthorableFormat {
  return (AUTHORABLE_FORMATS as readonly string[]).includes(format);
}

/**
 * Hand-authored theory. Blocks are content_blocks rows with kind = 'theory' and no source
 * document (classified_by = 'human'). Extracted blocks (Phase 7) share the table and can be
 * edited here once they are theory blocks. A block is visible to students only when it is
 * `published` and its sub-topic is visible.
 */
@Injectable()
export class TheoryAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: SyllabusRepository,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, subtopicId: string): Promise<AdminTheoryBlockListDto> {
    if (!(await this.repo.ancestry('subtopic', auth.tenantId, subtopicId, 'all'))) throw AppException.notFound('Sub-topic not found');
    const rows = await this.db
      .select()
      .from(contentBlocks)
      .where(
        and(
          eq(contentBlocks.tenantId, auth.tenantId),
          eq(contentBlocks.subtopicId, subtopicId),
          eq(contentBlocks.kind, 'theory'),
          isNull(contentBlocks.deletedAt),
        ),
      )
      .orderBy(asc(contentBlocks.sortOrder), asc(contentBlocks.createdAt), asc(contentBlocks.id));
    return { items: rows.map(toAdminBlock) };
  }

  async create(auth: AuthContext, subtopicId: string, dto: CreateTheoryBlockDto): Promise<AdminTheoryBlockDto> {
    const built = buildTheoryBlockContent({ format: dto.type, body: dto.body, items: dto.items, table: dto.table });
    if (!built.ok) throw AppException.validation(built.errors);
    const { rawText, contentJson } = built.value;

    return this.db.transaction(async (tx) => {
      if (!(await this.repo.lockLiveNode('subtopic', auth.tenantId, subtopicId, tx, 'share'))) throw AppException.notFound('Sub-topic not found');
      let sortOrder = dto.sortOrder;
      if (sortOrder === undefined) {
        const [last] = await tx
          .select({ m: max(contentBlocks.sortOrder) })
          .from(contentBlocks)
          .where(and(eq(contentBlocks.tenantId, auth.tenantId), eq(contentBlocks.subtopicId, subtopicId), eq(contentBlocks.kind, 'theory'), isNull(contentBlocks.deletedAt)));
        sortOrder = last?.m == null ? 0 : last.m + 1;
      }
      const publish = dto.publish === true;
      const [row] = await tx
        .insert(contentBlocks)
        .values({
          tenantId: auth.tenantId,
          kind: 'theory',
          format: dto.type,
          title: dto.title || null,
          rawText,
          normalizedText: rawText,
          contentJson,
          contentHash: contentHash(rawText),
          classifiedBy: 'human',
          subtopicId,
          sortOrder,
          status: publish ? 'published' : 'approved',
          reviewedBy: auth.userId,
          reviewedAt: sql`now()`,
          publishedAt: publish ? sql`now()` : null,
        })
        .returning();
      const out = toAdminBlock(row!);
      await this.audit.record(
        { tenantId: auth.tenantId, action: 'theory_block.created', entityType: 'content_block', entityId: out.id, after: { subtopicId, type: out.type, status: out.status, contentHash: out.contentHash } },
        tx,
      );
      return out;
    });
  }

  async update(auth: AuthContext, id: string, dto: UpdateTheoryBlockDto): Promise<AdminTheoryBlockDto> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(contentBlocks)
        .where(and(eq(contentBlocks.tenantId, auth.tenantId), eq(contentBlocks.id, id), eq(contentBlocks.kind, 'theory'), isNull(contentBlocks.deletedAt)))
        .for('update');
      if (!current) throw AppException.notFound('Theory block not found');
      if (!['approved', 'published'].includes(current.status)) {
        throw AppException.conflict(`This block is ${current.status}; review it in the content queue first`, 'INVALID_STATE');
      }

      const contentTouched = dto.type !== undefined || dto.body !== undefined || dto.items !== undefined || dto.table !== undefined;
      const patch: PgUpdateSetSource<typeof contentBlocks> = {};
      if (contentTouched) {
        const format = dto.type ?? current.format;
        if (!isAuthorable(format)) throw AppException.unprocessable(`${format} blocks can't be edited here`, 'INVALID_STATE');
        const rendered = renderBlock(current.format, current.normalizedText ?? current.rawText, current.contentJson);
        // Fields not in the request keep their current value, unless the type changes, in
        // which case structure that belongs to the old type is dropped.
        const typeChanged = format !== current.format;
        const built = buildTheoryBlockContent({
          format,
          body: dto.body !== undefined ? dto.body : rendered.body,
          items: dto.items !== undefined ? dto.items : typeChanged ? null : (rendered.items ?? null),
          table: dto.table !== undefined ? dto.table : typeChanged ? null : (rendered.table ?? null),
        });
        if (!built.ok) throw AppException.validation(built.errors);
        Object.assign(patch, {
          format,
          rawText: built.value.rawText,
          normalizedText: built.value.rawText,
          contentJson: built.value.contentJson,
          contentHash: contentHash(built.value.rawText),
        });
      }
      if (dto.title !== undefined) patch.title = dto.title ? normalizeText(dto.title) : null;
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      if (dto.status !== undefined && dto.status !== current.status) {
        patch.status = dto.status;
        patch.publishedAt = dto.status === 'published' ? sql`now()` : null;
      }
      if (Object.keys(patch).length === 0) return toAdminBlock(current);
      patch.reviewedBy = auth.userId;
      patch.reviewedAt = sql`now()`;

      const [row] = await tx
        .update(contentBlocks)
        .set(patch)
        .where(and(eq(contentBlocks.tenantId, auth.tenantId), eq(contentBlocks.id, id)))
        .returning();
      const out = toAdminBlock(row!);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: patch.status === 'published' ? 'theory_block.published' : patch.status === 'approved' ? 'theory_block.unpublished' : 'theory_block.updated',
          entityType: 'content_block',
          entityId: id,
          before: { status: current.status, contentHash: current.contentHash, sortOrder: current.sortOrder, title: current.title },
          after: { status: out.status, contentHash: out.contentHash, sortOrder: out.sortOrder, title: out.title },
        },
        tx,
      );
      return out;
    });
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(contentBlocks)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(contentBlocks.tenantId, auth.tenantId), eq(contentBlocks.id, id), eq(contentBlocks.kind, 'theory'), isNull(contentBlocks.deletedAt)))
        .returning({ id: contentBlocks.id, status: contentBlocks.status });
      if (!row) throw AppException.notFound('Theory block not found');
      await this.audit.record({ tenantId: auth.tenantId, action: 'theory_block.deleted', entityType: 'content_block', entityId: id, before: { status: row.status } }, tx);
    });
  }
}
