import { Injectable } from '@nestjs/common';
import type { LearnerAnalyticsDto, SubtopicPerformanceDto } from './dto/analytics.dto';

interface ReportUserData {
  name: string;
  email: string;
}

const LEVEL_NAMES = [
  'L1 Fundamental',
  'L2 Basic',
  'L3 Intermediate',
  'L4 Advanced',
  'L5 Mastery',
];

function escapePdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else if (code === 8212) out += '--';
    else if (code === 8211) out += '-';
    else if (code === 8216 || code === 8217) out += "'";
    else if (code === 8220 || code === 8221) out += '"';
    else if (code === 8230) out += '...';
    else if (code === 177) out += '+/-';
    else out += ' ';
  }
  return out;
}

@Injectable()
export class ReportPdfService {
  generatePerformanceReport(
    user: ReportUserData,
    analytics: LearnerAnalyticsDto,
    range: string,
  ): Buffer {
    const pages: string[] = [];
    const nowStr = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    const rangeLabel =
      range === '30d' ? 'Last 30 Days' : range === '90d' ? 'Last 90 Days' : 'All Time';

    const subtopics = analytics.subtopicPerformance ?? [];

    // Layout configuration
    // Page 1 can fit header, summary cards, level breakdown, and ~10 subtopics.
    // Subsequent pages can fit ~32 subtopics.
    const page1SubtopicCount = 10;
    const laterPageSubtopicCount = 32;

    const remainingCount = Math.max(0, subtopics.length - page1SubtopicCount);
    const additionalPages = Math.ceil(remainingCount / laterPageSubtopicCount);
    const totalPages = 1 + additionalPages;

    // --- Build Page 1 ---
    let p1 = '';

    // Header accent bar
    p1 += `0.26 0.38 0.93 rg 45 798 505 4 re f\n`;

    // Title & Subtitle
    p1 += `BT /F2 18 Tf 0.1 0.1 0.12 rg 1 0 0 1 45 768 Tm (${escapePdfText('ApexPrep - Student Performance Report')}) Tj ET\n`;
    const sub = `Student: ${user.name} (${user.email})   |   Generated: ${nowStr}   |   Range: ${rangeLabel}`;
    p1 += `BT /F1 9 Tf 0.4 0.42 0.48 rg 1 0 0 1 45 750 Tm (${escapePdfText(sub)}) Tj ET\n`;
    p1 += `0.85 0.88 0.92 rg 45 740 505 0.5 re f\n`;

    // Executive Summary Section
    p1 += `BT /F2 10 Tf 0.26 0.38 0.93 rg 1 0 0 1 45 722 Tm (${escapePdfText('OVERALL METRICS')}) Tj ET\n`;

    // 4 Summary Metric Boxes: (x, y, w, h)
    const metrics = [
      {
        label: 'Overall Accuracy',
        val: analytics.overallAccuracy !== null ? `${analytics.overallAccuracy}%` : '--',
      },
      {
        label: 'Questions Solved',
        val: String(analytics.questionsSolved),
      },
      {
        label: 'Average Pace',
        val: analytics.paceSeconds !== null ? `${analytics.paceSeconds}s / q` : '--',
      },
      {
        label: 'Syllabus Coverage',
        val: analytics.coveragePct !== null ? `${analytics.coveragePct}%` : '--',
      },
    ];

    const boxW = 120;
    const boxH = 46;
    const boxY = 666;
    for (let i = 0; i < metrics.length; i++) {
      const bx = 45 + i * 128;
      // Background and border
      p1 += `0.97 0.98 0.99 rg ${bx} ${boxY} ${boxW} ${boxH} re f\n`;
      p1 += `0.86 0.88 0.92 RG 0.5 w ${bx} ${boxY} ${boxW} ${boxH} re s\n`;
      // Text
      p1 += `BT /F1 8 Tf 0.45 0.47 0.52 rg 1 0 0 1 ${bx + 8} ${boxY + 30} Tm (${escapePdfText(metrics[i]!.label)}) Tj ET\n`;
      p1 += `BT /F2 14 Tf 0.1 0.12 0.16 rg 1 0 0 1 ${bx + 8} ${boxY + 12} Tm (${escapePdfText(metrics[i]!.val)}) Tj ET\n`;
    }

    // Mastery by Level Section
    const tierY = 640;
    p1 += `BT /F2 10 Tf 0.26 0.38 0.93 rg 1 0 0 1 45 ${tierY} Tm (${escapePdfText('ACCURACY BY MASTERY LEVEL')}) Tj ET\n`;

    const levelBoxW = 97;
    const levelBoxH = 40;
    const levelBoxY = 590;
    for (let l = 1; l <= 5; l++) {
      const lbx = 45 + (l - 1) * 102;
      const tierData = analytics.levelAccuracy?.find((la) => la.level === l);
      const accText = tierData?.accuracy !== null && tierData?.accuracy !== undefined ? `${tierData.accuracy}%` : '--';
      const countText = `${tierData?.attempted ?? 0} attempted`;

      p1 += `0.97 0.98 0.99 rg ${lbx} ${levelBoxY} ${levelBoxW} ${levelBoxH} re f\n`;
      p1 += `0.86 0.88 0.92 RG 0.5 w ${lbx} ${levelBoxY} ${levelBoxW} ${levelBoxH} re s\n`;
      p1 += `BT /F2 8 Tf 0.2 0.22 0.26 rg 1 0 0 1 ${lbx + 6} ${levelBoxY + 26} Tm (${escapePdfText(LEVEL_NAMES[l - 1]!)}) Tj ET\n`;
      p1 += `BT /F2 10 Tf 0.1 0.1 0.12 rg 1 0 0 1 ${lbx + 6} ${levelBoxY + 13} Tm (${escapePdfText(accText)}) Tj ET\n`;
      p1 += `BT /F1 7.5 Tf 0.5 0.52 0.56 rg 1 0 0 1 ${lbx + 42} ${levelBoxY + 13} Tm (${escapePdfText(countText)}) Tj ET\n`;
    }

    // Subtopic Performance Section Header
    const subtopicHeaderY = 566;
    p1 += `BT /F2 10 Tf 0.26 0.38 0.93 rg 1 0 0 1 45 ${subtopicHeaderY} Tm (${escapePdfText('SUBTOPIC PERFORMANCE DETAILS')}) Tj ET\n`;

    // Render Table Header
    const drawTableHeader = (startY: number): string => {
      let th = '';
      th += `0.92 0.94 0.96 rg 45 ${startY} 505 18 re f\n`;
      th += `0.82 0.84 0.88 RG 0.5 w 45 ${startY} 505 18 re s\n`;
      th += `BT /F2 8 Tf 0.15 0.18 0.22 rg\n`;
      th += `1 0 0 1 52 ${startY + 5} Tm (${escapePdfText('Subject')}) Tj\n`;
      th += `1 0 0 1 135 ${startY + 5} Tm (${escapePdfText('Subtopic')}) Tj\n`;
      th += `1 0 0 1 325 ${startY + 5} Tm (${escapePdfText('Solved')}) Tj\n`;
      th += `1 0 0 1 375 ${startY + 5} Tm (${escapePdfText('Accuracy')}) Tj\n`;
      th += `1 0 0 1 435 ${startY + 5} Tm (${escapePdfText('Mastery')}) Tj\n`;
      th += `1 0 0 1 490 ${startY + 5} Tm (${escapePdfText('Last Active')}) Tj\n`;
      th += `ET\n`;
      return th;
    };

    const drawSubtopicRow = (st: SubtopicPerformanceDto, rowY: number, idx: number): string => {
      let r = '';
      if (idx % 2 === 1) {
        r += `0.98 0.98 0.99 rg 45 ${rowY} 505 16 re f\n`;
      }
      r += `0.90 0.91 0.93 RG 0.4 w 45 ${rowY} 505 16 re s\n`;

      const subjectTrunc = st.subjectName.length > 14 ? st.subjectName.slice(0, 13) + '..' : st.subjectName;
      const subtopicTrunc = st.subtopicName.length > 32 ? st.subtopicName.slice(0, 31) + '..' : st.subtopicName;
      const acc = st.accuracy !== null ? `${st.accuracy}%` : '--';
      const level = st.level !== null ? `L${st.level}` : '--';
      const days = st.lastPracticedDays !== null ? (st.lastPracticedDays === 0 ? 'Today' : `${st.lastPracticedDays}d ago`) : '--';

      r += `BT /F1 8 Tf 0.15 0.18 0.22 rg\n`;
      r += `1 0 0 1 52 ${rowY + 4} Tm (${escapePdfText(subjectTrunc)}) Tj\n`;
      r += `1 0 0 1 135 ${rowY + 4} Tm (${escapePdfText(subtopicTrunc)}) Tj\n`;
      r += `1 0 0 1 330 ${rowY + 4} Tm (${escapePdfText(String(st.questions))}) Tj\n`;
      r += `1 0 0 1 380 ${rowY + 4} Tm (${escapePdfText(acc)}) Tj\n`;
      r += `1 0 0 1 445 ${rowY + 4} Tm (${escapePdfText(level)}) Tj\n`;
      r += `1 0 0 1 490 ${rowY + 4} Tm (${escapePdfText(days)}) Tj\n`;
      r += `ET\n`;
      return r;
    };

    const drawFooter = (pageNum: number): string => {
      let ft = '';
      ft += `0.85 0.88 0.92 rg 45 40 505 0.5 re f\n`;
      ft += `BT /F1 7.5 Tf 0.5 0.52 0.56 rg 1 0 0 1 45 28 Tm (${escapePdfText(
        'ApexPrep Learning System  |  Confidential Student Diagnostic Report',
      )}) Tj ET\n`;
      ft += `BT /F1 7.5 Tf 0.5 0.52 0.56 rg 1 0 0 1 500 28 Tm (${escapePdfText(
        `Page ${pageNum} of ${totalPages}`,
      )}) Tj ET\n`;
      return ft;
    };

    p1 += drawTableHeader(542);

    let curY = 524;
    const page1Items = subtopics.slice(0, page1SubtopicCount);
    page1Items.forEach((st, idx) => {
      p1 += drawSubtopicRow(st, curY, idx);
      curY -= 16;
    });

    if (page1Items.length === 0) {
      p1 += `BT /F1 9 Tf 0.5 0.5 0.5 rg 1 0 0 1 45 ${curY - 10} Tm (${escapePdfText(
        'No subtopics have been practised in this time range.',
      )}) Tj ET\n`;
    }

    p1 += drawFooter(1);
    pages.push(p1);

    // Additional pages if subtopics list is long
    let itemOffset = page1SubtopicCount;
    let pageIndex = 2;
    while (itemOffset < subtopics.length) {
      let px = '';
      // Header for continuation pages
      px += `0.26 0.38 0.93 rg 45 798 505 4 re f\n`;
      px += `BT /F2 12 Tf 0.1 0.12 0.16 rg 1 0 0 1 45 776 Tm (${escapePdfText(
        'ApexPrep - Subtopic Performance (Continued)',
      )}) Tj ET\n`;
      px += `BT /F1 8 Tf 0.45 0.47 0.52 rg 1 0 0 1 45 762 Tm (${escapePdfText(
        `Student: ${user.name}   |   Range: ${rangeLabel}`,
      )}) Tj ET\n`;

      px += drawTableHeader(736);

      let py = 718;
      const slice = subtopics.slice(itemOffset, itemOffset + laterPageSubtopicCount);
      slice.forEach((st, idx) => {
        px += drawSubtopicRow(st, py, idx);
        py -= 16;
      });

      px += drawFooter(pageIndex);
      pages.push(px);

      itemOffset += laterPageSubtopicCount;
      pageIndex++;
    }

    return this.assemblePdf(pages);
  }

  private assemblePdf(pageStreams: string[]): Buffer {
    const pageCount = pageStreams.length;
    // Objects:
    // 1: Catalog
    // 2: Pages
    // 3: Font Helvetica (Regular)
    // 4: Font Helvetica-Bold
    // Then 2 objects per page: Page Object, Content Stream Object
    const firstPageObject = 5;
    const pageIds = pageStreams.map((_, i) => firstPageObject + i * 2);
    const contentIds = pageIds.map((id) => id + 1);

    const objects: { number: number; body: string | Buffer }[] = [
      { number: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
      {
        number: 2,
        body: `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
      },
      {
        number: 3,
        body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
      },
      {
        number: 4,
        body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
      },
    ];

    pageStreams.forEach((content, index) => {
      const streamBuf = Buffer.from(content, 'latin1');
      objects.push({
        number: pageIds[index]!,
        body:
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentIds[index]!} 0 R >>`,
      });
      objects.push({
        number: contentIds[index]!,
        body: Buffer.concat([
          Buffer.from(`<< /Length ${streamBuf.length} >>\nstream\n`, 'latin1'),
          streamBuf,
          Buffer.from(`\nendstream`, 'latin1'),
        ]),
      });
    });

    // Assemble cross-reference table and trailer
    const parts: Buffer[] = [Buffer.from(`%PDF-1.4\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
    let offset = parts[0]!.length;
    const offsets = new Map<number, number>();

    for (const object of objects) {
      offsets.set(object.number, offset);
      const body = typeof object.body === 'string' ? Buffer.from(object.body, 'latin1') : object.body;
      const chunk = Buffer.concat([
        Buffer.from(`${object.number} 0 obj\n`, 'latin1'),
        body,
        Buffer.from(`\nendobj\n`, 'latin1'),
      ]);
      parts.push(chunk);
      offset += chunk.length;
    }

    const maxNumber = Math.max(...objects.map((o) => o.number));
    const xrefStart = offset;
    let xref = `xref\n0 ${maxNumber + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= maxNumber; n += 1) {
      const at = offsets.get(n);
      xref += at === undefined ? `0000000000 65535 f \n` : `${String(at).padStart(10, '0')} 00000 n \n`;
    }

    xref += `trailer\n<< /Size ${maxNumber + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));

    return Buffer.concat(parts);
  }
}
