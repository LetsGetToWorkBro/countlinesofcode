/**
 * A clean copy: the same document, with what it quietly carries taken out.
 *
 * inspect.ts reads back the metadata a file did not mean to send. This is the
 * other half: given the same file, write one that no longer carries it. It is
 * the privacy pass, not a redaction tool. It removes the "who, what and when"
 * a document records about its own making, the reviewer names on mark-up, and
 * the tracked changes and comments that were never accepted or deleted. It
 * does not touch the content: a bad redaction (text hidden under a black box)
 * is still text the author put there and only they know what to cut, so that
 * is left for a redaction tool and the page says so.
 *
 * The OOXML side is DOM-free string surgery on the parts, so it unit tests
 * under Node; the PDF side uses pdf-lib, which runs there too.
 */

import { PDFDocument, PDFDict, PDFName, PDFRef } from 'pdf-lib';
import { entry, type ZipEntry } from './zip';

const utf8 = new TextEncoder();
const textOf = (parts: ZipEntry[], name: string): string | null => {
  const data = entry(parts, name);
  return data ? new TextDecoder().decode(data) : null;
};

/**
 * Remove parts from a package and tidy up after them: drop their content-type
 * overrides and any relationship that points at them, so nothing is left
 * referring to a file that is gone.
 */
function dropParts(parts: ZipEntry[], drop: Set<string>): ZipEntry[] {
  const gone = new Set([...drop].map((n) => n.replace(/^.*\//, '')));
  return parts
    .filter((p) => !drop.has(p.name))
    .map((p) => {
      if (p.name === '[Content_Types].xml') {
        const xml = new TextDecoder().decode(p.data).replace(
          /<Override\b[^>]*PartName="\/([^"]+)"[^>]*\/>/g,
          (m, part) => (drop.has(part) ? '' : m),
        );
        return { name: p.name, data: utf8.encode(xml), store: p.store };
      }
      if (p.name.endsWith('.rels')) {
        const xml = new TextDecoder().decode(p.data).replace(/<Relationship\b[^>]*\/>/g, (m) => {
          const target = (/Target="([^"]+)"/.exec(m)?.[1] ?? '').replace(/^.*\//, '');
          return gone.has(target) ? '' : m;
        });
        return { name: p.name, data: utf8.encode(xml), store: p.store };
      }
      return p;
    });
}

export interface CleanResult<T> {
  /** The cleaned artefact: cleaned parts for OOXML, cleaned bytes for PDF. */
  value: T;
  /** Plain-language list of what was taken out, for the page to report. */
  removed: string[];
}

// ---------------------------------------------------------------------------
// Office files (OOXML)
// ---------------------------------------------------------------------------

/* An empty core-properties part is valid and carries nothing: no author, no
 * dates, no revision count, no title or keywords. Replacing the file outright
 * is safer than picking elements out of it one by one. */
const EMPTY_CORE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
  ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';

const EMPTY_CUSTOM =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"' +
  ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>';

/** Drop the personal fields from app.xml, leaving the harmless page counts. */
export function stripAppProps(xml: string): string {
  return xml
    .replace(/<Company>[\s\S]*?<\/Company>/g, '<Company></Company>')
    .replace(/<Manager>[\s\S]*?<\/Manager>/g, '')
    .replace(/<TotalTime>[\s\S]*?<\/TotalTime>/g, '<TotalTime>0</TotalTime>')
    .replace(/<Template>[\s\S]*?<\/Template>/g, '<Template>Normal.dotm</Template>')
    .replace(/<LastPrinted>[\s\S]*?<\/LastPrinted>/g, '');
}

/**
 * Accept every tracked change, so the file holds its final text and nothing
 * else. Inserted and moved-in runs keep their content and lose the wrapper;
 * deleted and moved-out runs go entirely; the records that store the old
 * formatting are dropped. Best effort on the markup a normal Word document
 * produces; deeply nested revisions are rare and not guaranteed.
 */
export function acceptRevisions(xml: string): string {
  return xml
    // Removed text: drop the element and everything it held.
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:del\b[^>]*\/>/g, '')
    .replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, '')
    .replace(/<w:moveFrom\b[^>]*\/>/g, '')
    // Added text: keep the content, drop the wrapper.
    .replace(/<\/?w:ins\b[^>]*>/g, '')
    .replace(/<\/?w:moveTo\b[^>]*>/g, '')
    // Empty range markers and the records of the old formatting.
    .replace(/<w:move(?:From|To)Range(?:Start|End)\b[^>]*\/?>/g, '')
    .replace(/<w:(?:rPr|pPr|tblPr|tcPr|trPr|tblGrid|sectPr|numbering)Change\b[^>]*>[\s\S]*?<\/w:(?:rPr|pPr|tblPr|tcPr|trPr|tblGrid|sectPr|numbering)Change>/g, '')
    .replace(/<w:(?:rPr|pPr|tblPr|tcPr|trPr|tblGrid|sectPr|numbering)Change\b[^>]*\/>/g, '');
}

/** Remove the comment anchors from a document part. */
export function stripCommentRefs(xml: string): string {
  return xml
    .replace(/<w:commentRangeStart\b[^>]*\/?>/g, '')
    .replace(/<w:commentRangeEnd\b[^>]*\/?>/g, '')
    // The reference sits alone in its own run; take the run with it.
    .replace(/<w:r\b[^>]*>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:commentReference\b[^>]*\/?><\/w:r>/g, '')
    .replace(/<w:commentReference\b[^>]*\/?>/g, '');
}

/** Parts that hold document body text, where changes and comments can hide. */
const BODY_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
/** The comment stores and the reviewer roster, in all their variants. */
const COMMENT_PART = /^word\/(comments(Extended|Ids|Extensible)?|people)\.xml$/;

export function cleanOoxml(parts: ZipEntry[], kind: 'docx' | 'xlsx' | 'pptx'): CleanResult<ZipEntry[]> {
  const removed: string[] = [];
  const out: ZipEntry[] = parts.map((p) => ({ name: p.name, data: p.data, store: p.store }));
  const set = (name: string, text: string) => {
    const e = out.find((p) => p.name === name);
    if (e) e.data = utf8.encode(text);
  };

  // 1. Document properties: author, dates, revision count, title, keywords.
  if (textOf(out, 'docProps/core.xml') !== null) {
    set('docProps/core.xml', EMPTY_CORE);
    removed.push('the document properties (author, dates, revision count)');
  }
  // 2. Extended properties: company, manager, editing time, template.
  const app = textOf(out, 'docProps/app.xml');
  if (app) {
    const stripped = stripAppProps(app);
    if (stripped !== app) {
      set('docProps/app.xml', stripped);
      removed.push('the company and editing-time fields');
    }
  }
  // 3. Custom properties.
  if (textOf(out, 'docProps/custom.xml') !== null) {
    set('docProps/custom.xml', EMPTY_CUSTOM);
    removed.push('the custom properties');
  }

  if (kind === 'docx') {
    // 4/5. Across the body parts, accept every tracked change and pull out the
    // comment anchors. Count the changes first, for the report.
    let changes = 0;
    const commentsXml = textOf(out, 'word/comments.xml');
    const commentCount = commentsXml ? (commentsXml.match(/<w:comment\b/g) ?? []).length : 0;
    for (const p of out) {
      if (!BODY_PART.test(p.name)) continue;
      const xml = new TextDecoder().decode(p.data);
      changes += (xml.match(/<w:(ins|del|moveFrom)\b/g) ?? []).length;
      p.data = utf8.encode(stripCommentRefs(acceptRevisions(xml)));
    }
    if (changes) removed.push(`${changes} tracked change${changes === 1 ? '' : 's'}, accepted`);

    // Then drop the comment stores and the reviewer roster outright, tidying
    // the relationships and content types that pointed at them.
    const drop = new Set(out.filter((p) => COMMENT_PART.test(p.name)).map((p) => p.name));
    if (drop.size) {
      const kept = dropParts(out, drop);
      out.length = 0;
      out.push(...kept);
      removed.push(commentCount ? `${commentCount} comment${commentCount === 1 ? '' : 's'}` : 'the reviewer records');
    }
  }

  return { value: out, removed };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const INFO_KEYS = ['Author', 'Creator', 'Producer', 'Title', 'Subject', 'Keywords', 'CreationDate', 'ModDate'];

/**
 * Strip a PDF's document information, its XMP block, and the reviewer names
 * (and dates) on any mark-up, then write it back. The page content is left
 * exactly as it was.
 */
export async function cleanPdf(bytes: Uint8Array): Promise<CleanResult<Uint8Array>> {
  const removed: string[] = [];
  // updateMetadata:false stops pdf-lib stamping its own Producer and a fresh
  // modified-date onto the file the moment it loads, which would put back two
  // of the very things being removed.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });

  // The document information dictionary in the trailer.
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef) {
    const info = doc.context.lookup(infoRef, PDFDict);
    if (info) {
      const had = INFO_KEYS.filter((k) => info.has(PDFName.of(k)));
      for (const key of INFO_KEYS) info.delete(PDFName.of(key));
      if (had.length) removed.push('the author, software and timestamps');
    }
  }

  // The XMP metadata stream hanging off the catalogue. Dropping the reference
  // is not enough: pdf-lib writes every object it holds, referenced or not, so
  // the stream (and its <x:xmpmeta> bytes) has to leave the context too.
  const metaRef = doc.catalog.get(PDFName.of('Metadata'));
  if (metaRef) {
    doc.catalog.delete(PDFName.of('Metadata'));
    if (metaRef instanceof PDFRef) doc.context.delete(metaRef);
    removed.push('the XMP metadata block');
  }

  // Reviewer names and dates on annotations (comments, mark-up, stamps).
  let named = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i), PDFDict);
      if (!annot) continue;
      if (annot.has(PDFName.of('T'))) { annot.delete(PDFName.of('T')); named++; }
      annot.delete(PDFName.of('M'));
    }
  }
  if (named) removed.push('the names on comments and mark-up');

  const out = await doc.save({ updateFieldAppearances: false });
  return { value: out, removed };
}
