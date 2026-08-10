/**
 * What a document quietly carries that its sender did not mean to send.
 *
 * People attach files all day without ever looking inside them. A PDF names the
 * software and operating system that made it, and timestamps it with a timezone
 * offset. A .docx keeps who last saved it, how many minutes it was edited for,
 * often the company name, and — routinely — tracked changes and comments that
 * were never accepted or deleted, only hidden from view.
 *
 * None of that is exotic or a bug. It is the format working as designed, and it
 * has ended careers and lost lawsuits. This module reads it back out.
 *
 * The most serious check here is the redaction one, and it works from the
 * rendered page rather than from the file's structure: for every piece of text
 * the file will hand over, it asks whether that text is actually *visible*. Text
 * that can be extracted but cannot be seen is text somebody believed they had
 * removed. That catches a black box drawn over a name, white text on white
 * paper, and text hidden behind an image, without needing to understand how any
 * of the three were done.
 *
 * DOM-free, so it unit tests under Node; the caller does the rendering.
 */

import { entry, type ZipEntry } from './zip';

export type Severity = 'high' | 'medium' | 'low';

export interface Leak {
  severity: Severity;
  title: string;
  /** What was actually found, quoted where it helps. */
  detail: string;
  /** What to do about it, when there is something to do. */
  advice?: string;
}

export interface Report {
  kind: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'unknown';
  leaks: Leak[];
  /** Checks that were run and came back clean, so silence is not ambiguous. */
  clean: string[];
}

const decoder = new TextDecoder('latin1');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A PDF date is `D:YYYYMMDDHHmmSS+HH'mm'`. The offset is the interesting part:
 * it is the timezone of the machine that wrote the file, which narrows down
 * where its author was sitting.
 */
export function timezoneOf(pdfDate: string | undefined | null): string | null {
  if (!pdfDate) return null;
  const match = /([+-])(\d{2})'?(\d{2})?/.exec(String(pdfDate).replace(/^D:\d{14}/, ''));
  if (!match) return /Z$/.test(String(pdfDate)) ? 'UTC' : null;
  return `UTC${match[1]}${match[2]}:${match[3] ?? '00'}`;
}

/** Operating system named outright by a producer or creator string. */
export function osFrom(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = String(value);
  if (/macintosh|mac os|darwin/i.test(text)) return 'macOS';
  if (/windows|win32|win64/i.test(text)) return 'Windows';
  if (/linux/i.test(text)) return 'Linux';
  return null;
}

const trim = (value: unknown, max = 90): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Document-information values, as pdf.js reports them. */
export interface PdfInfo {
  Author?: string;
  Creator?: string;
  Producer?: string;
  Title?: string;
  Subject?: string;
  Keywords?: string;
  CreationDate?: string;
  ModDate?: string;
}

export interface PdfFeatures {
  /** Names found on annotations, which carry their author. */
  annotationAuthors?: string[];
  /** Text that can be extracted but cannot be seen on the page. */
  hiddenText?: { page: number; text: string }[];
  hasXmp?: boolean;
  hasJavaScript?: boolean;
  hasEmbeddedFiles?: boolean;
  hasLayers?: boolean;
  externalLinks?: string[];
  pages?: number;
  /** How many pages were actually scanned for hidden text. */
  pagesChecked?: number;
}

/** Structural flags read straight from the bytes, without a full parse. */
export function pdfFeaturesFromBytes(bytes: Uint8Array): PdfFeatures {
  const raw = decoder.decode(bytes);
  const links = [...raw.matchAll(/\/URI\s*\(([^)]{1,120})\)/g)].map((m) => m[1]!);
  return {
    hasXmp: /<x:xmpmeta/.test(raw),
    // /OpenAction is left out on purpose: its overwhelmingly common form is a
    // view/destination action carrying no script (open at page 3, zoom to
    // fit), and flagging every one as "contains JavaScript" cried wolf on
    // ordinary PDFs. Real script is /JavaScript or /JS, and inspect-page also
    // asks pdf.js getJSActions() for the authoritative answer.
    hasJavaScript: /\/JavaScript|\/JS[\s/[]/.test(raw),
    hasEmbeddedFiles: /\/EmbeddedFiles|\/Filespec/.test(raw),
    hasLayers: /\/OCProperties/.test(raw),
    externalLinks: [...new Set(links)],
  };
}

export function inspectPdf(info: PdfInfo, features: PdfFeatures): Report {
  const leaks: Leak[] = [];
  const clean: string[] = [];

  // The headline: text that is present but invisible.
  const hidden = features.hiddenText ?? [];
  const checked = features.pagesChecked;
  const total = features.pages;
  const partialScan = checked !== undefined && total !== undefined && checked < total;

  if (hidden.length) {
    const sample = hidden.slice(0, 3).map((h) => `“${trim(h.text, 48)}” (page ${h.page + 1})`).join(', ');
    leaks.push({
      severity: 'high',
      title: `${hidden.length} piece${hidden.length === 1 ? '' : 's'} of text you cannot see, but anyone can copy`,
      detail:
        `This text is in the file and will come straight out of a copy-paste, yet none of it is visible on the page: ${sample}. ` +
        'That is what a black box drawn over a name looks like from the inside, and white text on white paper, and text hidden behind an image.',
      advice:
        'If any of this was meant to be removed, it has not been. Delete it properly, or black it out with a tool that flattens the page.',
    });
  } else {
    // The all-clear always carries the textured-cover caveat: the check finds a
    // flat cover (a solid box, white-on-white) but a photographic or patterned
    // cover has high pixel variance and reads as "visible", so the claim must
    // not promise more than the method delivers. This caveat used to vanish
    // whenever the scan was partial, replaced by a scope line that made no
    // mention of the method's blind spot.
    clean.push('No text hiding under a solid box or in white-on-white. A photographic or patterned cover over text could still hide it, so check those by eye');
  }

  // Disclose an incomplete scan independently of whether anything was found: a
  // clean result on 20 of 30 pages says nothing about the other 10, and neither
  // does a hit on page 3. Previously the scope note only appeared on a clean
  // scan, so a document with hidden text on a checked page looked fully scanned.
  if (partialScan) {
    clean.push(`Only the first ${checked} of ${total} page${checked === 1 ? '' : 's'} ${checked === 1 ? 'was' : 'were'} scanned for hidden text; the rest were not checked`);
  }

  if (info.Author) {
    leaks.push({
      severity: 'high',
      title: 'The author’s name is in the file',
      detail: `Author: “${trim(info.Author)}”.`,
      advice: 'Remove it before sending this anywhere you would not sign.',
    });
  } else {
    clean.push('No author name recorded');
  }

  const software = [info.Creator, info.Producer].filter(Boolean).map((v) => trim(v));
  const os = osFrom(info.Creator) ?? osFrom(info.Producer);
  if (software.length) {
    leaks.push({
      severity: os ? 'medium' : 'low',
      title: os ? `The software and operating system that made it (${os})` : 'The software that made it',
      detail: software.join(' · ') + (os ? `, which names ${os} outright.` : ''),
      advice: 'Harmless on its own; useful to somebody building a picture of you.',
    });
  }

  const zone = timezoneOf(info.CreationDate) ?? timezoneOf(info.ModDate);
  if (info.CreationDate || info.ModDate) {
    leaks.push({
      severity: zone && zone !== 'UTC' ? 'medium' : 'low',
      title: zone && zone !== 'UTC' ? `When it was written, and the author’s timezone (${zone})` : 'When it was written',
      detail:
        [info.CreationDate ? `Created ${trim(info.CreationDate, 40)}` : '', info.ModDate ? `Modified ${trim(info.ModDate, 40)}` : '']
          .filter(Boolean)
          .join(' · ') +
        (zone && zone !== 'UTC' ? ` The offset ${zone} narrows down roughly where in the world it was written.` : ''),
    });
  }

  if (features.annotationAuthors?.length) {
    leaks.push({
      severity: 'high',
      title: 'Comments or mark-up, with the names of who made them',
      detail: `Named: ${[...new Set(features.annotationAuthors)].map((a) => `“${trim(a, 30)}”`).join(', ')}.`,
      advice: 'Reviewer notes are frequently left in by accident. Check whether these were meant to travel with the file.',
    });
  }

  if (features.hasEmbeddedFiles) {
    leaks.push({
      severity: 'high',
      title: 'Whole other files are attached inside this PDF',
      detail: 'The PDF carries embedded file attachments, which travel with it and are easy to forget about.',
      advice: 'Open the attachments panel in a reader and check what is in there.',
    });
  } else {
    clean.push('No files attached inside it');
  }

  if (features.hasJavaScript) {
    leaks.push({
      severity: 'medium',
      title: 'It contains JavaScript',
      detail: 'PDFs can carry scripts that run when the document opens. Usually a form doing arithmetic; occasionally not.',
      advice: 'Worth knowing before you open it in a reader that runs scripts.',
    });
  } else {
    clean.push('No embedded JavaScript');
  }

  if (features.hasLayers) {
    leaks.push({
      severity: 'medium',
      title: 'It has optional layers',
      detail: 'Content is organised into layers that can be switched on and off. A hidden layer is still in the file.',
      advice: 'Check whether any layer is switched off by default.',
    });
  }

  if (features.hasXmp) {
    leaks.push({
      severity: 'low',
      title: 'An XMP metadata block',
      detail: 'A second, richer block of metadata, which often keeps a document identifier that survives edits and links versions of a file together.',
    });
  }

  if (features.externalLinks?.length) {
    leaks.push({
      severity: 'low',
      title: `${features.externalLinks.length} external link${features.externalLinks.length === 1 ? '' : 's'}`,
      detail: [...new Set(features.externalLinks)].slice(0, 4).map((l) => trim(l, 60)).join(' · '),
      advice: 'A link with a unique code in it can report back when the document is opened.',
    });
  }

  return { kind: 'pdf', leaks, clean };
}

// ---------------------------------------------------------------------------
// Office files (OOXML)
// ---------------------------------------------------------------------------

const textOf = (parts: ZipEntry[], name: string): string | null => {
  const data = entry(parts, name);
  return data ? new TextDecoder().decode(data) : null;
};

const tagValue = (xml: string | null, tag: string): string | null => {
  if (!xml) return null;
  const match = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
  return match?.[1]?.trim() || null;
};

/** Minutes of editing, as Word records it, rendered as something readable. */
export function editingTime(minutes: string | null): string | null {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 60) return `${value} minutes`;
  const hours = Math.floor(value / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ${value % 60} minutes`;
}

export function inspectOoxml(parts: ZipEntry[], kind: Report['kind']): Report {
  const leaks: Leak[] = [];
  const clean: string[] = [];

  const core = textOf(parts, 'docProps/core.xml');
  const app = textOf(parts, 'docProps/app.xml');

  const creator = tagValue(core, 'dc:creator');
  const modifier = tagValue(core, 'cp:lastModifiedBy');
  const people = [...new Set([creator, modifier].filter(Boolean) as string[])];
  if (people.length) {
    leaks.push({
      severity: 'high',
      title: 'The names of the people who wrote and last saved it',
      detail:
        [creator ? `Created by “${trim(creator, 40)}”` : '', modifier ? `last saved by “${trim(modifier, 40)}”` : '']
          .filter(Boolean)
          .join(', ') + '.',
      advice: 'This is the single most common way a document says who really wrote it.',
    });
  } else {
    clean.push('No author names recorded');
  }

  const company = tagValue(app, 'Company');
  if (company) {
    leaks.push({
      severity: 'medium',
      title: 'The company name it was written at',
      detail: `Company: “${trim(company, 50)}”.`,
      advice: 'Set from the Office installation, not from anything you typed.',
    });
  }

  const manager = tagValue(app, 'Manager');
  if (manager) {
    leaks.push({ severity: 'medium', title: 'A manager’s name', detail: `Manager: “${trim(manager, 50)}”.` });
  }

  const edited = editingTime(tagValue(app, 'TotalTime'));
  if (edited) {
    leaks.push({
      severity: 'low',
      title: 'How long it was actually worked on',
      detail: `Total editing time: ${edited}.`,
      advice: 'Occasionally awkward: it is the difference between "I spent all week on this" and four minutes.',
    });
  }

  const revision = tagValue(core, 'cp:revision');
  if (revision && Number(revision) > 1) {
    leaks.push({
      severity: 'low',
      title: `It has been saved ${revision} times`,
      detail: `Revision number ${revision}, plus the created and last-modified timestamps.`,
    });
  }

  const template = tagValue(app, 'Template');
  if (template && template !== 'Normal.dotm' && template !== 'Normal') {
    leaks.push({
      severity: 'low',
      title: 'The template it was built from',
      detail: `Template: “${trim(template, 60)}”, sometimes a full path on somebody’s machine.`,
    });
  }

  // Tracked changes and comments: present in the file, invisible in the window.
  const document = textOf(parts, 'word/document.xml') ?? '';
  const insertions = (document.match(/<w:ins\b/g) ?? []).length;
  const deletions = (document.match(/<w:del\b/g) ?? []).length;
  // Moved text is a tracked change too, recorded as w:moveFrom/w:moveTo pairs.
  // Counting the moveFrom regions (the original location, which still holds the
  // moved words) catches a "No tracked changes" false clean on a document where
  // text was only rearranged.
  const moves = (document.match(/<w:moveFrom\b/g) ?? []).length;
  const authors = [...new Set([...document.matchAll(/w:author="([^"]{1,60})"/g)].map((m) => m[1]!))];

  const changes = insertions + deletions + moves;
  if (changes > 0) {
    const parts_ = [
      `${insertions} insertion${insertions === 1 ? '' : 's'}`,
      `${deletions} deletion${deletions === 1 ? '' : 's'}`,
    ];
    if (moves) parts_.push(`${moves} moved passage${moves === 1 ? '' : 's'}`);
    leaks.push({
      severity: 'high',
      title: `${changes} tracked change${changes === 1 ? '' : 's'} still in the document`,
      detail:
        parts_.join(', ') +
        (authors.length ? `, by ${authors.map((a) => `“${trim(a, 30)}”`).join(', ')}` : '') +
        '. Deleted or moved text that was never accepted is still in the file, word for word.',
      advice: 'Accept or reject every change before sending this. Turning off "show markup" hides them; it does not remove them.',
    });
  } else if (document) {
    clean.push('No tracked changes left in it');
  }

  const comments = textOf(parts, 'word/comments.xml');
  if (comments) {
    const commentAuthors = [...new Set([...comments.matchAll(/w:author="([^"]{1,60})"/g)].map((m) => m[1]!))];
    const count = (comments.match(/<w:comment\b/g) ?? []).length;
    leaks.push({
      severity: 'high',
      title: `${count} comment${count === 1 ? '' : 's'} attached to the document`,
      detail: commentAuthors.length ? `Written by ${commentAuthors.map((a) => `“${trim(a, 30)}”`).join(', ')}.` : 'Comments are stored in the file.',
      advice: 'Internal discussion very often lives in comments. Delete them before the file leaves the building.',
    });
  } else if (document) {
    clean.push('No comments attached');
  }

  // <w:vanish/> hides a run, but <w:vanish w:val="false"/> explicitly un-hides
  // one (a run overriding a character style that sets vanish). Counting the
  // latter as hidden text is a false positive on text that displays normally.
  const hidden = [...document.matchAll(/<w:vanish\b([^>]*)\/?>/g)].filter((m) => {
    const val = /w:val="([^"]*)"/.exec(m[1]!)?.[1]?.toLowerCase();
    return val === undefined || !['false', '0', 'off'].includes(val);
  }).length;
  if (hidden) {
    leaks.push({
      severity: 'high',
      title: 'It contains text marked hidden',
      detail: `${hidden} run${hidden === 1 ? ' is' : 's are'} formatted as hidden text, which does not show on screen or in print but is in the file.`,
      advice: 'Anyone can reveal it by switching hidden text on.',
    });
  }

  const embeddings = parts.filter((p) => /(^word|^xl|^ppt)\/embeddings\//.test(p.name));
  if (embeddings.length) {
    leaks.push({
      severity: 'medium',
      title: `${embeddings.length} embedded object${embeddings.length === 1 ? '' : 's'} inside it`,
      detail: 'Whole other files (a spreadsheet inside a document, say) carried along complete, not just the picture you see.',
      advice: 'An embedded spreadsheet keeps all its rows, including the ones outside the chart you pasted.',
    });
  }

  // Paths in relationships: how a local filename ends up in a sent document.
  const rels = parts.filter((p) => p.name.endsWith('.rels'));
  const paths = new Set<string>();
  for (const rel of rels) {
    const xml = new TextDecoder().decode(rel.data);
    for (const match of xml.matchAll(/Target="(file:[^"]+|[A-Za-z]:\\[^"]+)"/g)) paths.add(match[1]!);
  }
  if (paths.size) {
    leaks.push({
      severity: 'high',
      title: 'File paths from the author’s own computer',
      detail: [...paths].slice(0, 3).map((p) => trim(p, 70)).join(' · '),
      advice: 'These usually contain a username, and sometimes a client or project name.',
    });
  } else {
    clean.push('No local file paths left in it');
  }

  if (kind === 'xlsx') {
    const sheets = parts.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p.name)).length;
    const workbook = textOf(parts, 'xl/workbook.xml') ?? '';
    const hiddenSheets = (workbook.match(/state="(hidden|veryHidden)"/g) ?? []).length;
    if (hiddenSheets) {
      leaks.push({
        severity: 'high',
        title: `${hiddenSheets} hidden worksheet${hiddenSheets === 1 ? '' : 's'}`,
        detail: `The workbook has ${sheets} sheet${sheets === 1 ? '' : 's'}, ${hiddenSheets} of which ${hiddenSheets === 1 ? 'is' : 'are'} hidden from view but fully present.`,
        advice: 'Right-click any tab and choose Unhide to see what is in them. So can the person you send it to.',
      });
    } else if (sheets) {
      clean.push('No hidden worksheets');
    }
  }

  return { kind, leaks, clean };
}

// ---------------------------------------------------------------------------
// The visibility test behind the redaction check
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a piece of text actually sits on the rendered page.
 *
 * A text item's transform is not always a plain translation: text can be
 * rotated, and papers rotate it constantly for figure axes and table headers.
 * Treating a rotated run as a horizontal box samples blank paper beside it,
 * which then reads as "invisible" and floods the report with false alarms — a
 * real academic paper produced 64 of them before this existed.
 *
 * So the box is built from the transform's own direction vectors: one along the
 * direction the text advances, one along the direction its glyphs stand up in.
 * The result is the axis-aligned box that actually contains the run, whichever
 * way round it is written.
 */
export function textBox(
  transform: number[],
  width: number,
  size: number,
  pageHeight: number,
  scale: number,
): Box {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = transform;
  const advance = Math.hypot(a, b) || 1;
  const upright = Math.hypot(c, d) || size || 10;
  const ux = a / advance;
  const uy = b / advance;
  const vx = c / upright;
  const vy = d / upright;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const along = corner === 1 || corner === 2 ? width : 0;
    // Descenders drop below the baseline, so the box starts a little under it.
    const up = corner >= 2 ? size : -size * 0.22;
    xs.push(e + ux * along + vx * up);
    ys.push(f + uy * along + vy * up);
  }

  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return {
    x: Math.round(x0 * scale),
    // Canvases count down from the top; PDF counts up from the bottom.
    y: Math.round((pageHeight - y1) * scale),
    w: Math.max(1, Math.round((x1 - x0) * scale)),
    h: Math.max(1, Math.round((y1 - y0) * scale)),
  };
}

export interface PatchStats {
  /** Mean brightness, 0 (black) to 255 (white). */
  mean: number;
  /** Spread of brightness across the patch. */
  variance: number;
}

/**
 * Whether a patch of page containing text shows no sign of that text.
 *
 * Visible writing is high-contrast by nature: dark glyphs on a light ground, so
 * the brightness across the patch varies a lot. A patch that is nearly uniform
 * has nothing drawn on it that the eye can pick out — it is a solid black box,
 * or blank paper where white text has been set on white. Either way, text the
 * file will happily hand over is text nobody can see.
 *
 * The threshold is deliberately cautious. Calling visible text "hidden" would
 * cry wolf about an ordinary document, so this only fires when a patch is very
 * nearly flat.
 */
export const FLAT_VARIANCE = 120;

export function looksHidden(stats: PatchStats): boolean {
  return stats.variance < FLAT_VARIANCE;
}

/** Brightness statistics for one rectangle of RGBA pixels. */
export function patchStats(pixels: Uint8ClampedArray): PatchStats {
  const count = pixels.length / 4;
  if (count === 0) return { mean: 255, variance: 0 };
  let total = 0;
  let squares = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // Rec. 601 luma, which is close enough to how dark a pixel looks.
    const luma = 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
    total += luma;
    squares += luma * luma;
  }
  const mean = total / count;
  return { mean, variance: Math.max(0, squares / count - mean * mean) };
}
