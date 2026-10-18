import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../database/database.module';
import { subjects, tracks } from '../database/schema';
import type { PageText } from './segmentation';
import type { SubjectContext } from './syllabus-suggestions.repository';
import type { AiService } from '../ai/ai.service';
import { buildSubjectDetectionPrompt, parseSubjectDetectionReply, type SubjectCandidate } from '../ai/prompts';
import { normalizeText } from './hierarchy';

export interface SubjectDetectionInput {
  tenantId: string;
  db: Database;
  ai: AiService;
  pages: readonly PageText[];
  hints?: {
    trackId?: string | null;
    subjectId?: string | null;
  };
}

/**
 * Automatically determine the subject from the uploaded PDF content.
 *
 * Rules:
 *   1. If the uploader provided an explicit subject hint, verify and return it.
 *   2. If omitted, retrieve all active candidate subjects in this organisation (optionally narrowed by track hint).
 *   3. If AI is configured, use structured subject classification to match document content to a syllabus subject.
 *   4. Deterministic fallback: check document title and preface for prominent subject names.
 *   5. If ambiguous or below the 0.85 confidence threshold, return null (never guess; send to review).
 */
export async function detectSubjectFromDocument(input: SubjectDetectionInput): Promise<SubjectContext | null> {
  const { tenantId, db, ai, pages, hints } = input;

  // 1. If subject hint was explicitly provided, load it directly
  if (hints?.subjectId) {
    const [row] = await db
      .select({
        subjectId: subjects.id,
        subjectName: subjects.name,
        trackId: tracks.id,
        trackName: tracks.name,
      })
      .from(subjects)
      .innerJoin(tracks, and(eq(tracks.tenantId, subjects.tenantId), eq(tracks.id, subjects.trackId)))
      .where(and(eq(subjects.tenantId, tenantId), eq(subjects.id, hints.subjectId), isNull(subjects.deletedAt), isNull(tracks.deletedAt)))
      .limit(1);
    if (row) return row;
  }

  let candidateRows = await db
    .select({
      subjectId: subjects.id,
      subjectName: subjects.name,
      trackId: tracks.id,
      trackName: tracks.name,
    })
    .from(subjects)
    .innerJoin(tracks, and(eq(tracks.tenantId, subjects.tenantId), eq(tracks.id, subjects.trackId)))
    .where(
      and(
        eq(subjects.tenantId, tenantId),
        isNull(subjects.deletedAt),
        isNull(tracks.deletedAt),
        hints?.trackId ? eq(tracks.id, hints.trackId) : undefined,
      ),
    );

  // If the hinted track has no subjects, fall back to searching all active subjects in the organisation
  if (candidateRows.length === 0 && hints?.trackId) {
    candidateRows = await db
      .select({
        subjectId: subjects.id,
        subjectName: subjects.name,
        trackId: tracks.id,
        trackName: tracks.name,
      })
      .from(subjects)
      .innerJoin(tracks, and(eq(tracks.tenantId, subjects.tenantId), eq(tracks.id, subjects.trackId)))
      .where(and(eq(subjects.tenantId, tenantId), isNull(subjects.deletedAt), isNull(tracks.deletedAt)));
  }

  if (candidateRows.length === 0) return null;

  // Sample text from the first pages (up to 3 pages)
  const samplePages = pages.slice(0, 3);
  const sampleText = samplePages.map((p) => p.text).join('\n');
  const normalizedSample = ` ${normalizeText(sampleText)} `;

  // 3. AI-powered classification if configured
  if (ai.configured) {
    const candidates: SubjectCandidate[] = candidateRows.map((c) => ({
      subjectId: c.subjectId,
      subjectName: c.subjectName,
      trackName: c.trackName,
    }));
    const validSubjectIds = new Set(candidates.map((c) => c.subjectId));

    try {
      const prompt = buildSubjectDetectionPrompt(candidates, sampleText);
      const reply = await ai.generateJson(
        {
          task: 'subject_detection',
          prompt,
          temperature: 0,
          maxOutputTokens: 1024,
        },
        (text) => parseSubjectDetectionReply(text, validSubjectIds),
      );

      if (reply.value.subjectId && reply.value.confidence >= 0.85) {
        const matched = candidateRows.find((c) => c.subjectId === reply.value.subjectId);
        if (matched) return matched;
      }
    } catch {
      // AI unavailable or unparseable; proceed to deterministic fallback
    }
  }

  // 4. Deterministic content matching fallback: check title/first page lines
  const firstPageLines = (pages[0]?.text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 10);

  for (const candidate of candidateRows) {
    const normSubject = normalizeText(candidate.subjectName);
    if (normSubject.length < 3) continue;

    // Check if the subject name appears as a standalone word or title in the first 10 lines
    const titleMatch = firstPageLines.some((line) => {
      const normLine = normalizeText(line);
      return normLine === normSubject || normLine.startsWith(`${normSubject} `) || normLine.endsWith(` ${normSubject}`);
    });

    if (titleMatch) {
      return candidate;
    }
  }

  // Also check if exactly one candidate has high occurrence in the first 3 pages
  const matches = candidateRows.filter((c) => {
    const norm = normalizeText(c.subjectName);
    return norm.length >= 3 && normalizedSample.includes(` ${norm} `);
  });

  if (matches.length === 1) {
    return matches[0]!;
  }

  // 5. Ambiguous or undetected: return null so it is safely reviewed by a human
  return null;
}
