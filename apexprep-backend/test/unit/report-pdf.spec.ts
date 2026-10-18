import { ReportPdfService } from '../../src/analytics/report-pdf.service';
import { PdfDocument } from '../../src/pdf/pdf-document';
import type { LearnerAnalyticsDto, SubtopicPerformanceDto } from '../../src/analytics/dto/analytics.dto';

describe('ReportPdfService', () => {
  const service = new ReportPdfService();

  const mockAnalytics: LearnerAnalyticsDto = {
    range: 'all',
    overallAccuracy: 82.5,
    accuracyDelta: 4.2,
    questionsSolved: 120,
    paceSeconds: 75,
    coveragePct: 65,
    levelAccuracy: [
      { level: 1, attempted: 30, correct: 28, accuracy: 93.3 },
      { level: 2, attempted: 40, correct: 35, accuracy: 87.5 },
      { level: 3, attempted: 30, correct: 24, accuracy: 80.0 },
      { level: 4, attempted: 15, correct: 10, accuracy: 66.7 },
      { level: 5, attempted: 5, correct: 3, accuracy: 60.0 },
    ],
    trend: [],
    weakSubtopics: [],
    strongSubtopics: [],
    subtopicPerformance: [
      {
        subtopicId: 'st-1',
        subtopicName: 'Newton Laws of Motion',
        subjectId: 'sub-1',
        subjectName: 'Physics',
        topicName: 'Dynamics',
        questions: 35,
        accuracy: 85.7,
        level: 3,
        paceSeconds: 72,
        lastPracticedDays: 2,
      },
      {
        subtopicId: 'st-2',
        subtopicName: 'Thermodynamics & Heat',
        subjectId: 'sub-1',
        subjectName: 'Physics',
        topicName: 'Heat Transfer',
        questions: 25,
        accuracy: 76.0,
        level: 2,
        paceSeconds: 84,
        lastPracticedDays: 0,
      },
    ],
    subjectSummary: [],
  };

  it('generates a valid, readable PDF document', () => {
    const buffer = service.generatePerformanceReport(
      { name: 'Arjun Verma', email: 'arjun@example.com' },
      mockAnalytics,
      'all',
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Parse and validate with internal PdfDocument parser
    const doc = PdfDocument.parse(buffer);
    const validation = doc.validate(10);
    expect(validation.ok).toBe(true);
    expect(validation.encrypted).toBe(false);
    expect(validation.pageCount).toBe(1);

    const pages = doc.extractText();
    expect(pages.length).toBe(1);
    expect(pages[0]!.text).toContain('ApexPrep - Student Performance Report');
    expect(pages[0]!.text).toContain('Arjun Verma');
    expect(pages[0]!.text).toContain('Newton Laws of Motion');
  });

  it('paginates correctly when many subtopics are present', () => {
    const manySubtopics: SubtopicPerformanceDto[] = Array.from({ length: 25 }, (_, i) => ({
      subtopicId: `st-${i}`,
      subtopicName: `Subtopic Performance Topic ${i + 1}`,
      subjectId: 'sub-1',
      subjectName: 'Mathematics',
      topicName: 'Integration',
      questions: 10 + i,
      accuracy: 70 + (i % 20),
      level: 1 + (i % 5),
      paceSeconds: 65,
      lastPracticedDays: i,
    }));

    const buffer = service.generatePerformanceReport(
      { name: 'Priya Sharma', email: 'priya@example.com' },
      { ...mockAnalytics, subtopicPerformance: manySubtopics },
      '30d',
    );

    const doc = PdfDocument.parse(buffer);
    const validation = doc.validate(10);
    expect(validation.ok).toBe(true);
    expect(validation.pageCount).toBe(2);

    const pages = doc.extractText();
    expect(pages.length).toBe(2);
    expect(pages[0]!.text).toContain('Page 1 of 2');
    expect(pages[1]!.text).toContain('Page 2 of 2');
  });
});
