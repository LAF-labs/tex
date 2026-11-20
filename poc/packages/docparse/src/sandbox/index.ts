import { readCsv } from './csv.ts';
import { sniffFormat } from './format.ts';
import { readHtmlTable } from './html-table.ts';
import { MAX_INPUT_BYTES, SandboxError } from './limits.ts';
import type { SheetOutput } from './sheet.ts';
import { readXls } from './xls.ts';
import { readXlsx } from './xlsx.ts';

export * from './cfb.ts';
export * from './csv.ts';
export * from './format.ts';
export * from './html-table.ts';
export * from './image.ts';
export * from './limits.ts';
export * from './sheet.ts';
export * from './text.ts';
export * from './x509.ts';
export * from './xls.ts';
export * from './xlsx.ts';
export * from './xml.ts';
export * from './zip.ts';

/** 표 파일(xlsx·xls·HTML 표·CSV) 바이트 → 표. 형식은 머리로 고른다. */
export async function readSheetBytes(bytes: Uint8Array): Promise<SheetOutput> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) throw new SandboxError('input_size');
  const f = sniffFormat(bytes);
  if (!('format' in f)) throw new SandboxError('unsupported_format');
  if (f.format === 'xlsx') return readXlsx(bytes);
  if (f.format === 'xls') return readXls(bytes);
  if (f.format === 'html') return readHtmlTable(bytes);
  if (f.format === 'csv') return readCsv(bytes);
  throw new SandboxError('unsupported_format');
}
