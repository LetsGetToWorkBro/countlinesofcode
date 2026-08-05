/**
 * Reading and writing .docx, against the shared document model.
 *
 * A .docx is a ZIP of OOXML. The parts that matter for a conversion are
 * `word/document.xml` (the content), `word/styles.xml` (what "Heading 1"
 * means) and `word/numbering.xml` (whether a list is bulleted or numbered).
 * Everything else — themes, settings, fonts, revision history — is Word's
 * business and is not reproduced.
 *
 * The XML is parsed with a small scanner rather than DOMParser, for one reason:
 * this file has to run under Node for its tests, and it is a narrow, known
 * grammar. Word writes it; nobody hand-authors document.xml.
 */

import { tidy, type Block, type Doc, type Run, type TableCell } from './docmodel';
import { entry, unzip, zip, type ZipEntry } from './zip';

const OOXML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML at all and Word refuses the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// ---------------------------------------------------------------------------
// A minimal XML scanner
// ---------------------------------------------------------------------------

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Parse XML into a tree. Namespace prefixes are kept (`w:p`), as written. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let at = 0;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(source))) {
    const parent = stack[stack.length - 1]!;
    const between = source.slice(at, match.index);
    if (between) parent.text += decodeEntities(between);
    at = tag.lastIndex;

    if (!match[2]) continue; // a declaration or a comment
    const [, closing, name, rawAttrs, selfClosing] = match;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const attrs: Record<string, string> = {};
    const attr = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(rawAttrs ?? ''))) attrs[a[1]!] = decodeEntities(a[2]!);

    const node: XmlNode = { name: name!, attrs, children: [], text: '' };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    const value = code.startsWith('#x') || code.startsWith('#X')
      ? parseInt(code.slice(2), 16)
      : parseInt(code.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
  });
}

const kids = (node: XmlNode, name: string): XmlNode[] => node.children.filter((c) => c.name === name);
const kid = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((c) => c.name === name);

/** Depth-first search for the first element with this name. */
function find(node: XmlNode, name: string): XmlNode | undefined {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = find(child, name);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Heading level from a style id or name: "Heading2", "heading 2", "Title". */
export function headingLevel(style: string | undefined): number | null {
  if (!style) return null;
  const normalised = style.toLowerCase().replace(/[\s_-]/g, '');
  if (normalised === 'title') return 1;
  if (normalised === 'subtitle') return 2;
  const match = /^heading([1-9])$/.exec(normalised);
  return match ? Number(match[1]) : null;
}

function runsOf(paragraph: XmlNode): Run[] {
  const runs: Run[] = [];
  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      if (child.name === 'w:r') {
        const props = kid(child, 'w:rPr');
        const bold = props ? Boolean(kid(props, 'w:b')) : false;
        const italic = props ? Boolean(kid(props, 'w:i')) : false;
        // w:sz is in half-points.
        const half = props ? kid(props, 'w:sz')?.attrs['w:val'] : undefined;
        const size = half ? Number(half) / 2 : undefined;
        let text = '';
        for (const part of child.children) {
          if (part.name === 'w:t') text += part.text;
          else if (part.name === 'w:tab') text += '\t';
          else if (part.name === 'w:br' || part.name === 'w:cr') text += '\n';
        }
        if (text) {
          const run: Run = { text };
          if (bold) run.bold = true;
          if (italic) run.italic = true;
          if (size && Number.isFinite(size)) run.size = size;
          runs.push(run);
        }
      } else if (child.name !== 'w:pPr') {
        // Hyperlinks and smart tags wrap runs; descend rather than skip them.
        walk(child);
      }
    }
  };
  walk(paragraph);
  return runs;
}

/** Whether this paragraph carries an explicit page break. */
function hasPageBreak(paragraph: XmlNode): boolean {
  let found = false;
  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      if (child.name === 'w:br' && child.attrs['w:type'] === 'page') found = true;
      else walk(child);
    }
  };
  walk(paragraph);
  return found;
}

function cellOf(node: XmlNode): TableCell {
  const runs: Run[] = [];
  for (const paragraph of kids(node, 'w:p')) runs.push(...runsOf(paragraph));
  return { runs };
}

/**
 * Which numbering ids are ordered lists.
 *
 * numbering.xml maps a numId to an abstract definition whose first level has a
 * format: "bullet" for a bulleted list, anything else (decimal, lowerLetter…)
 * for a numbered one.
 */
function orderedNumbering(root: XmlNode | null): Set<string> {
  const ordered = new Set<string>();
  // parseXml returns a wrapper whose child is the document element, so the
  // real <w:numbering> has to be found rather than assumed to be the root.
  const numbering = root ? find(root, 'w:numbering') : undefined;
  if (!numbering) return ordered;
  const formats = new Map<string, string>();
  for (const abstract of kids(numbering, 'w:abstractNum')) {
    const id = abstract.attrs['w:abstractNumId'];
    const level = kids(abstract, 'w:lvl')[0];
    const format = level ? kid(level, 'w:numFmt')?.attrs['w:val'] : undefined;
    if (id) formats.set(id, format ?? 'decimal');
  }
  for (const num of kids(numbering, 'w:num')) {
    const numId = num.attrs['w:numId'];
    const abstractId = kid(num, 'w:abstractNumId')?.attrs['w:val'];
    if (!numId) continue;
    const format = abstractId ? formats.get(abstractId) : undefined;
    if (format && format !== 'bullet') ordered.add(numId);
  }
  return ordered;
}

/** Map style id -> style name, so "Heading1" is found however it was declared. */
function styleNames(root: XmlNode | null): Map<string, string> {
  const names = new Map<string, string>();
  const styles = root ? find(root, 'w:styles') : undefined;
  if (!styles) return names;
  for (const style of kids(styles, 'w:style')) {
    const id = style.attrs['w:styleId'];
    const name = kid(style, 'w:name')?.attrs['w:val'];
    if (id) names.set(id, name ?? id);
  }
  return names;
}

/** Read a .docx into the shared model. */
export async function readDocx(source: Uint8Array): Promise<Doc> {
  const parts = await unzip(source);
  const documentXml = entry(parts, 'word/document.xml');
  if (!documentXml) throw new Error('That file is a ZIP but not a Word document: it has no word/document.xml.');

  const decoder = new TextDecoder();
  const document = parseXml(decoder.decode(documentXml));
  const styles = entry(parts, 'word/styles.xml');
  const numbering = entry(parts, 'word/numbering.xml');
  const names = styleNames(styles ? parseXml(decoder.decode(styles)) : null);
  const ordered = orderedNumbering(numbering ? parseXml(decoder.decode(numbering)) : null);

  const body = find(document, 'w:body');
  const blocks: Block[] = [];

  for (const node of body?.children ?? []) {
    if (node.name === 'w:p') {
      // A page break is a paragraph whose only content is a page-type break.
      // Without this it reads as an empty paragraph and is tidied away, so a
      // document losing its pagination on a round trip.
      if (hasPageBreak(node)) {
        blocks.push({ kind: 'pageBreak', runs: [] });
        continue;
      }
      const props = kid(node, 'w:pPr');
      const styleId = props ? kid(props, 'w:pStyle')?.attrs['w:val'] : undefined;
      const level = headingLevel(styleId) ?? headingLevel(styleId ? names.get(styleId) : undefined);
      const numbered = props ? kid(props, 'w:numPr') : undefined;
      const runs = runsOf(node);

      if (numbered) {
        const numId = kid(numbered, 'w:numId')?.attrs['w:val'];
        const depth = Number(kid(numbered, 'w:ilvl')?.attrs['w:val'] ?? '0') + 1;
        blocks.push({ kind: 'listItem', level: depth, ordered: numId ? ordered.has(numId) : false, runs });
      } else if (level) {
        blocks.push({ kind: 'heading', level, runs });
      } else {
        blocks.push({ kind: 'paragraph', runs });
      }
    } else if (node.name === 'w:tbl') {
      const rows = kids(node, 'w:tr').map((row) => kids(row, 'w:tc').map(cellOf));
      blocks.push({ kind: 'table', runs: [], rows });
    }
  }

  return tidy({ blocks });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function runXml(run: Run): string {
  const props: string[] = [];
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.size) props.push(`<w:sz w:val="${Math.round(run.size * 2)}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  // A newline inside a run has to become an explicit break element.
  const body = run.text
    .split('\n')
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join('<w:br/>');
  return `<w:r>${rPr}${body}</w:r>`;
}

function blockXml(block: Block): string {
  if (block.kind === 'pageBreak') {
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  if (block.kind === 'table') {
    const rows = (block.rows ?? [])
      .map((row) => {
        const cells = row
          .map(
            (cell) =>
              `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>` +
              `<w:p>${cell.runs.map(runXml).join('')}</w:p></w:tc>`,
          )
          .join('');
        return `<w:tr>${cells}</w:tr>`;
      })
      .join('');
    // A visible grid: a table whose borders are "none" reads as loose columns.
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="auto"/>`)
      .join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${rows}</w:tbl>`;
  }

  const props: string[] = [];
  if (block.kind === 'heading') {
    props.push(`<w:pStyle w:val="Heading${Math.min(Math.max(block.level ?? 1, 1), 6)}"/>`);
  } else if (block.kind === 'listItem') {
    props.push('<w:pStyle w:val="ListParagraph"/>');
    props.push(
      `<w:numPr><w:ilvl w:val="${Math.max((block.level ?? 1) - 1, 0)}"/>` +
        `<w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`,
    );
  }
  const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${block.runs.map(runXml).join('')}</w:p>`;
}

function stylesXml(): string {
  const heading = (level: number, size: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/>` +
    `<w:spacing w:before="${240 - level * 20}" w:after="120"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${OOXML}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
${[1, 2, 3, 4, 5, 6].map((l) => heading(l, [32, 28, 26, 24, 22, 22][l - 1]!)).join('\n')}
</w:styles>`;
}

/** One bulleted definition and one numbered one, which is all the model needs. */
function numberingXml(): string {
  const levels = (format: string, text: string, font: string) =>
    Array.from({ length: 6 }, (_, i) =>
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
      `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr>` +
      `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr></w:lvl>`,
    ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${OOXML}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet', '•', 'Symbol')}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('decimal', '%1.', 'Calibri')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
}

/** Write the model as a .docx. */
export async function writeDocx(doc: Doc): Promise<Uint8Array> {
  const body = doc.blocks.map(blockXml).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${OOXML}"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  const parts: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_RELS}">
<Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_RELS}">
<Relationship Id="rId1" Type="${DOC_RELS}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${DOC_RELS}/numbering" Target="numbering.xml"/>
</Relationships>`),
    },
    {
      name: 'docProps/core.xml',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(doc.title ?? '')}</dc:title></cp:coreProperties>`),
    },
    { name: 'word/styles.xml', data: bytes(stylesXml()) },
    { name: 'word/numbering.xml', data: bytes(numberingXml()) },
    { name: 'word/document.xml', data: bytes(documentXml) },
  ];

  return zip(parts);
}
