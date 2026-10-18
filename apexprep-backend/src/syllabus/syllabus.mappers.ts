import type { ChapterRow, SubjectRow, SubtopicRow, TopicRow, TrackRow } from '../database/schema';
import type {
  BreadcrumbDto,
  ChapterDto,
  ChapterNodeDto,
  SubjectDto,
  SubjectNodeDto,
  SubtopicDto,
  SubtopicNodeDto,
  TopicDto,
  TopicNodeDto,
  TrackDto,
} from './dto/syllabus.dto';
import type { Ancestry, SubtreeRows } from './syllabus.repository';

/** Explicit field picks: a DTO never spreads a row, so new columns can't leak by accident. */

export const toTrackDto = (r: TrackRow): TrackDto => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  shortName: r.shortName,
  description: r.description,
  examYear: r.examYear,
  examDate: r.examDate,
  // The learning context (migration 0013). Coalesced to null so a column the database left NULL is
  // reported as "not stated" rather than as an absent field.
  kind: r.kind ?? null,
  educationStage: r.educationStage ?? null,
  gradeLabel: r.gradeLabel ?? null,
  gradeOrdinal: r.gradeOrdinal ?? null,
  examFamily: r.examFamily ?? null,
  curriculum: r.curriculum ?? null,
  locale: r.locale ?? null,
  sortOrder: r.sortOrder,
  status: r.status,
});

export const toSubjectDto = (r: SubjectRow): SubjectDto => ({
  id: r.id,
  trackId: r.trackId,
  slug: r.slug,
  name: r.name,
  colorHex: r.colorHex,
  sortOrder: r.sortOrder,
  status: r.status,
});

export const toChapterDto = (r: ChapterRow): ChapterDto => ({
  id: r.id,
  subjectId: r.subjectId,
  slug: r.slug,
  name: r.name,
  weightagePct: r.weightagePct,
  sortOrder: r.sortOrder,
  status: r.status,
});

export const toTopicDto = (r: TopicRow): TopicDto => ({
  id: r.id,
  chapterId: r.chapterId,
  slug: r.slug,
  name: r.name,
  sortOrder: r.sortOrder,
  status: r.status,
});

export const toSubtopicDto = (r: SubtopicRow): SubtopicDto => ({
  id: r.id,
  topicId: r.topicId,
  slug: r.slug,
  name: r.name,
  description: r.description,
  sortOrder: r.sortOrder,
  status: r.status,
});

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

const sum = (xs: { questionCount: number }[]) => xs.reduce((n, x) => n + x.questionCount, 0);

/**
 * Assembles nested nodes from the flat rows `SyllabusRepository.subtree` returns.
 * Question counts roll up from sub-topics. `mastery` stays null until analytics exist.
 */
export class TreeAssembler {
  private readonly chaptersBySubject: Map<string, ChapterRow[]>;
  private readonly topicsByChapter: Map<string, TopicRow[]>;
  private readonly subtopicsByTopic: Map<string, SubtopicRow[]>;

  constructor(private readonly rows: SubtreeRows) {
    this.chaptersBySubject = groupBy(rows.chapters, (r) => r.subjectId);
    this.topicsByChapter = groupBy(rows.topics, (r) => r.chapterId);
    this.subtopicsByTopic = groupBy(rows.subtopics, (r) => r.topicId);
  }

  subtopic(r: SubtopicRow): SubtopicNodeDto {
    return {
      ...toSubtopicDto(r),
      questionCount: this.rows.questionCounts.get(r.id) ?? 0,
      hasTheory: this.rows.withTheory.has(r.id),
      mastery: null,
    };
  }

  topic(r: TopicRow): TopicNodeDto {
    const subtopics = (this.subtopicsByTopic.get(r.id) ?? []).map((s) => this.subtopic(s));
    return { ...toTopicDto(r), questionCount: sum(subtopics), mastery: null, subtopics };
  }

  chapter(r: ChapterRow): ChapterNodeDto {
    const topics = (this.topicsByChapter.get(r.id) ?? []).map((t) => this.topic(t));
    return { ...toChapterDto(r), questionCount: sum(topics), mastery: null, topics };
  }

  subject(r: SubjectRow): SubjectNodeDto {
    const chapters = (this.chaptersBySubject.get(r.id) ?? []).map((c) => this.chapter(c));
    return { ...toSubjectDto(r), questionCount: sum(chapters), mastery: null, chapters };
  }

  subjects(): SubjectNodeDto[] {
    return this.rows.subjects.map((s) => this.subject(s));
  }
}

export function breadcrumbs(a: Ancestry, upTo: 'subject' | 'chapter' | 'topic' | 'subtopic'): BreadcrumbDto[] {
  const chain: BreadcrumbDto[] = [{ level: 'track', id: a.track.id, slug: a.track.slug, name: a.track.name }];
  const order = ['subject', 'chapter', 'topic', 'subtopic'] as const;
  for (const level of order) {
    if (level === upTo) break;
    const node = a[level];
    if (node) chain.push({ level, id: node.id, slug: node.slug, name: node.name });
  }
  return chain;
}
