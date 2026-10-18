import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database } from '../database/database.module';
import { contentBlocks } from '../database/schema';
import type {
  ChapterDetailDto,
  SubjectDetailDto,
  SubtopicDetailDto,
  SyllabusLevel,
  TopicDetailDto,
  TrackDto,
  TrackListDto,
  TrackTreeDto,
} from './dto/syllabus.dto';
import type { TheoryDto } from './dto/theory.dto';
import { breadcrumbs, toSubjectDto, toTrackDto, TreeAssembler } from './syllabus.mappers';
import { SyllabusRepository, type Ancestry, type Visibility } from './syllabus.repository';
import { estimateReadMinutes, renderBlock } from './theory-text';

const NOT_FOUND: Record<SyllabusLevel, string> = {
  track: 'Track not found',
  subject: 'Subject not found',
  chapter: 'Chapter not found',
  topic: 'Topic not found',
  subtopic: 'Sub-topic not found',
};

/**
 * Read side of the syllabus. Student routes call these with `published`; admin routes with
 * `all`. A node that is invisible to the caller answers 404, exactly like one that doesn't exist.
 */
@Injectable()
export class SyllabusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: SyllabusRepository,
  ) {}

  async listTracks(tenantId: string, v: Visibility): Promise<TrackListDto> {
    const trackRows = await this.repo.listTracks(tenantId, v);
    const subjectRows = await this.repo.subjectsOfTracks(tenantId, trackRows.map((t) => t.id), v);
    return {
      items: trackRows.map((t) => ({
        ...toTrackDto(t),
        subjects: subjectRows
          .filter((s) => s.trackId === t.id)
          .map((s) => {
            const { id, slug, name, colorHex } = toSubjectDto(s);
            return { id, slug, name, colorHex };
          }),
      })),
    };
  }

  async getTrack(tenantId: string, trackId: string, v: Visibility): Promise<TrackDto> {
    return toTrackDto((await this.require('track', tenantId, trackId, v)).track);
  }

  async getTree(tenantId: string, trackId: string, v: Visibility): Promise<TrackTreeDto> {
    const { track } = await this.require('track', tenantId, trackId, v);
    const subjects = new TreeAssembler(await this.repo.subtree(tenantId, 'track', [track.id], v)).subjects();
    return { track: toTrackDto(track), questionCount: subjects.reduce((n, s) => n + s.questionCount, 0), subjects };
  }

  async getSubject(tenantId: string, id: string, v: Visibility): Promise<SubjectDetailDto> {
    const a = await this.require('subject', tenantId, id, v);
    const tree = new TreeAssembler(await this.repo.subtree(tenantId, 'subject', [id], v));
    return { breadcrumbs: breadcrumbs(a, 'subject'), subject: tree.subject(a.subject!) };
  }

  async getChapter(tenantId: string, id: string, v: Visibility): Promise<ChapterDetailDto> {
    const a = await this.require('chapter', tenantId, id, v);
    const tree = new TreeAssembler(await this.repo.subtree(tenantId, 'chapter', [id], v));
    return { breadcrumbs: breadcrumbs(a, 'chapter'), chapter: tree.chapter(a.chapter!) };
  }

  async getTopic(tenantId: string, id: string, v: Visibility): Promise<TopicDetailDto> {
    const a = await this.require('topic', tenantId, id, v);
    const tree = new TreeAssembler(await this.repo.subtree(tenantId, 'topic', [id], v));
    return { breadcrumbs: breadcrumbs(a, 'topic'), topic: tree.topic(a.topic!) };
  }

  async getSubtopic(tenantId: string, id: string, v: Visibility): Promise<SubtopicDetailDto> {
    const a = await this.require('subtopic', tenantId, id, v);
    const tree = new TreeAssembler(await this.repo.subtree(tenantId, 'subtopic', [id], v));
    return { breadcrumbs: breadcrumbs(a, 'subtopic'), subtopic: tree.subtopic(a.subtopic!) };
  }

  /**
   * Published theory for a visible sub-topic, in reading order. Only `kind = 'theory'`
   * blocks are read: question and solution blocks extracted from the same pages are never
   * returned here.
   */
  async getTheory(tenantId: string, subtopicId: string): Promise<TheoryDto> {
    const { subtopic } = await this.require('subtopic', tenantId, subtopicId, 'published');
    const rows = await this.db
      .select({
        id: contentBlocks.id,
        format: contentBlocks.format,
        title: contentBlocks.title,
        rawText: contentBlocks.rawText,
        normalizedText: contentBlocks.normalizedText,
        contentJson: contentBlocks.contentJson,
      })
      .from(contentBlocks)
      .where(
        and(
          eq(contentBlocks.tenantId, tenantId),
          eq(contentBlocks.subtopicId, subtopicId),
          eq(contentBlocks.kind, 'theory'),
          eq(contentBlocks.status, 'published'),
          isNull(contentBlocks.deletedAt),
        ),
      )
      .orderBy(asc(contentBlocks.sortOrder), asc(contentBlocks.createdAt), asc(contentBlocks.id));

    const blocks = rows.map((r) => ({ id: r.id, type: r.format, title: r.title, ...renderBlock(r.format, r.normalizedText ?? r.rawText, r.contentJson) }));
    return {
      subtopicId: subtopic!.id,
      title: subtopic!.name,
      readMinutes: estimateReadMinutes(rows.flatMap((r) => [r.title ?? '', r.normalizedText ?? r.rawText])),
      blocks,
    };
  }

  private async require(level: SyllabusLevel, tenantId: string, id: string, v: Visibility): Promise<Ancestry> {
    const a = await this.repo.ancestry(level, tenantId, id, v);
    if (!a) throw AppException.notFound(NOT_FOUND[level]);
    return a;
  }
}
