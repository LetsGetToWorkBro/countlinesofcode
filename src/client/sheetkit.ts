/**
 * The spreadsheet engine, bundled to public/sheetkit.js.
 *
 * Small: a .xlsx is a ZIP of XML, and both the ZIP and the XML are handled by
 * code this site already owns, so nothing heavy is pulled in.
 */

import { parseCsv, readXlsx, sniffDelimiter, writeCsv, writeXlsx } from './sheet';

const globalScope = globalThis as unknown as { LOC1999_SHEET?: Record<string, unknown> };
globalScope.LOC1999_SHEET = { readXlsx, writeXlsx, parseCsv, writeCsv, sniffDelimiter };
