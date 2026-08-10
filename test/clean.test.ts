/**
 * The clean-copy pass, checked against the inspector it exists to satisfy.
 *
 * The strongest test is the round trip: take a file the inspector would flag,
 * clean it, inspect the result, and assert the flags are gone. The Office side
 * runs the real zip/unzip and inspectOoxml; the PDF side builds a file with
 * pdf-lib, cleans it, and reads it back.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import {
  acceptRevisions,
  cleanOoxml,
  cleanPdf,
  stripAppProps,
  stripCommentRefs,
} from '../src/client/clean';
import { inspectOoxml } from '../src/client/inspect';
import type { ZipEntry } from '../src/client/zip';

const enc = (s: string): ZipEntry['data'] => new TextEncoder().encode(s);
const part = (name: string, xml: string): ZipEntry => ({ name, data: enc(xml) });

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cp2="x">
<dc:creator>Jane Author</dc:creator>
<cp:lastModifiedBy>Bob Editor</cp:lastModifiedBy>
<cp:revision>7</cp:revision>
<dcterms:created xmlns:dcterms="http://purl.org/dc/terms/">2021-03-04T09:00:00Z</dcterms:created>
</cp:coreProperties>`;

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Microsoft Office Word</Application>
<Pages>3</Pages>
<Company>Acme Legal LLP</Company>
<Manager>Big Boss</Manager>
<TotalTime>428</TotalTime>
<Template>C:\\Users\\jane\\brief.dotx</Template>
</Properties>`;

const DOCUMENT = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Kept text </w:t></w:r>
<w:ins w:id="2" w:author="Jane Author" w:date="2021-03-04T09:00:00Z"><w:r><w:t>added words</w:t></w:r></w:ins>
<w:del w:id="3" w:author="Bob Editor"><w:r><w:delText>secret removed sentence</w:delText></w:r></w:del>
<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>
</w:body></w:document>`;

const COMMENTS = `<?xml version="1.0"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:comment w:id="1" w:author="Bob Editor" w:date="2021-03-04T10:00:00Z"><w:p><w:r><w:t>fix this before sending</w:t></w:r></w:p></w:comment>
</w:comments>`;

const PEOPLE = `<?xml version="1.0"?>
<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
<w15:person w15:author="Bob Editor"><w15:presenceInfo w15:providerId="None" w15:userId="Bob Editor"/></w15:person>
</w15:people>`;

function docxParts(): ZipEntry[] {
  return [
    part('docProps/core.xml', CORE),
    part('docProps/app.xml', APP),
    part('docProps/custom.xml', '<Properties><property name="ClientMatter"><vt:lpwstr>Project Falcon</vt:lpwstr></property></Properties>'),
    part('word/document.xml', DOCUMENT),
    part('word/comments.xml', COMMENTS),
    part('word/people.xml', PEOPLE),
  ];
}

describe('cleaning an Office file', () => {
  it('removes everything the inspector flags, and keeps the text', () => {
    const before = inspectOoxml(docxParts(), 'docx');
    // sanity: the fixture really is dirty
    expect(before.leaks.some((l) => /people who wrote/.test(l.title))).toBe(true);
    expect(before.leaks.some((l) => /tracked change/.test(l.title))).toBe(true);
    expect(before.leaks.some((l) => /comment/.test(l.title))).toBe(true);
    expect(before.leaks.some((l) => /company/.test(l.title))).toBe(true);

    const { value, removed } = cleanOoxml(docxParts(), 'docx');
    const after = inspectOoxml(value, 'docx');

    expect(after.leaks, JSON.stringify(after.leaks)).toEqual([]);
    expect(after.clean).toContain('No author names recorded');
    expect(after.clean).toContain('No tracked changes left in it');
    expect(after.clean).toContain('No comments attached');
    expect(removed.length).toBeGreaterThan(2);

    // The kept text survives; the deleted sentence and the comment body do not.
    const doc = new TextDecoder().decode(value.find((p) => p.name === 'word/document.xml')!.data);
    expect(doc).toContain('Kept text');
    expect(doc).toContain('added words');
    expect(doc).not.toContain('secret removed sentence');
    // The comment store and the reviewer roster are gone entirely.
    expect(value.find((p) => p.name === 'word/comments.xml')).toBeUndefined();
    expect(value.find((p) => p.name === 'word/people.xml')).toBeUndefined();
    expect(doc).not.toContain('Bob Editor');
  });

  it('accepts insertions and drops deletions', () => {
    const xml = '<w:p><w:ins w:author="x"><w:r><w:t>in</w:t></w:r></w:ins>' +
      '<w:del w:author="x"><w:r><w:delText>out</w:delText></w:r></w:del></w:p>';
    const out = acceptRevisions(xml);
    expect(out).toContain('in');
    expect(out).not.toContain('out');
    expect(out).not.toContain('w:ins');
    expect(out).not.toContain('w:del');
    expect(out).not.toContain('w:author');
  });

  it('strips company and editing time but keeps the page count', () => {
    const out = stripAppProps(APP);
    expect(out).not.toContain('Acme Legal LLP');
    expect(out).not.toContain('Big Boss');
    expect(out).toContain('<Pages>3</Pages>');
    expect(out).toContain('<Company></Company>');
    expect(out).toContain('<TotalTime>0</TotalTime>');
  });

  it('pulls comment anchors out of the body', () => {
    const out = stripCommentRefs('<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>t</w:t></w:r>' +
      '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>');
    expect(out).toContain('<w:t>t</w:t>');
    expect(out).not.toContain('commentRange');
    expect(out).not.toContain('commentReference');
  });
});

describe('cleaning a PDF', () => {
  async function dirtyPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setAuthor('Jane Author');
    doc.setTitle('Confidential Brief');
    doc.setSubject('do not distribute');
    doc.setProducer('AcmeWriter 3.2 for Windows');
    doc.setCreator('AcmeWriter');
    doc.setCreationDate(new Date('2021-03-04T09:00:00Z'));
    doc.setModificationDate(new Date('2021-03-05T09:00:00Z'));
    // An uncompressed XMP packet, the way a real file carries one.
    const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Jane Author</dc:creator></rdf:Description>' +
      '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    return doc.save();
  }

  it('starts dirty', async () => {
    const bytes = await dirtyPdf();
    const raw = new TextDecoder('latin1').decode(bytes);
    expect(raw).toContain('x:xmpmeta');
    const reload = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(reload.getAuthor()).toBe('Jane Author');
  });

  it('clears the info dictionary and the XMP block', async () => {
    const { value, removed } = await cleanPdf(await dirtyPdf());
    const raw = new TextDecoder('latin1').decode(value);
    expect(raw, 'XMP survived').not.toContain('xmpmeta');
    expect(raw, 'author name survived').not.toContain('Jane Author');
    expect(raw).not.toContain('AcmeWriter');

    const doc = await PDFDocument.load(value, { updateMetadata: false });
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.getCreator()).toBeUndefined();
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
    expect(doc.getPageCount(), 'the page went with it').toBe(1);
    expect(removed.length).toBeGreaterThan(0);
  });

  it('strips reviewer names off annotations', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const annot = doc.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 20, 20],
      T: 'Jane Author', M: 'D:20210304090000Z', Contents: 'a note',
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
    const { value } = await cleanPdf(await doc.save());

    // Read the annotation back: the name is gone, the note it was on remains.
    const reload = await PDFDocument.load(value, { updateMetadata: false });
    const annots = reload.getPage(0).node.Annots()!;
    const a = reload.context.lookup(annots.get(0), PDFDict)!;
    expect(a.has(PDFName.of('T'))).toBe(false);
    expect(a.has(PDFName.of('M'))).toBe(false);
    expect(a.has(PDFName.of('Contents')), 'the note itself was kept').toBe(true);
  });
});
