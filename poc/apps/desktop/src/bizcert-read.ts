import { BIZ_FIELD_MAX, type BizFields } from './onboarding.ts';

type BizCertFormat = 'pdf' | 'png' | 'jpeg';

export interface BizCertReadPorts {
  pick(): Promise<Uint8Array | null>;
  pdfText(bytes: Uint8Array, o: { forceOcr: boolean }): Promise<string>;
  imageText(bytes: Uint8Array): Promise<string>;
  parse(text: string): Promise<unknown>;
  log?: (name: string, data: Record<string, string | number>) => void;
}

export function bizCertFormat(b: Uint8Array): BizCertFormat | null {
  if (b.length >= 5 && Buffer.from(b.subarray(0, Math.min(b.length, 1024))).indexOf('%PDF-') >= 0) return 'pdf';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

const FIELD_OF = { name: 'name', bizNo: 'bizNo', rep: 'repName', bizType: 'bizType', bizItem: 'bizItem', address: 'address' } as const;

export function bizFieldsOf(r: unknown): BizFields | null {
  const f = (r as { fields?: unknown } | null)?.fields;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const src = f as Record<string, unknown>;
  const val = (k: keyof typeof FIELD_OF) => {
    const v = src[FIELD_OF[k]];
    return typeof v === 'string' ? [...v].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').trim().slice(0, BIZ_FIELD_MAX[k]) : '';
  };
  return { name: val('name'), bizNo: val('bizNo').replace(/\D/g, ''), rep: val('rep'), bizType: val('bizType'), bizItem: val('bizItem'), address: val('address'), email: '' };
}

const usable = (b: BizFields | null): b is BizFields => !!b && (b.name !== '' || b.bizNo.length === 10);
const blanks = (b: BizFields) => (['name', 'bizNo', 'rep', 'bizType', 'bizItem', 'address'] as const).filter((k) => !b[k]).length;
const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown } | null)?.code;
  const m = (e as Error | null)?.message;
  const s = typeof c === 'string' ? c : typeof m === 'string' ? m : 'failed';
  return /^[a-z_]{1,40}$/.test(s) ? s : 'failed';
};

export async function readBizCert(p: BizCertReadPorts): Promise<BizFields | null> {
  const log = p.log ?? (() => {});
  let bytes: Uint8Array | null;
  try {
    bytes = await p.pick();
  } catch (e) {
    log('main.bizcert_read', { result: codeOf(e) });
    return null;
  }
  if (!bytes) return null;
  const format = bizCertFormat(bytes);
  if (!format) {
    bytes.fill(0);
    log('main.bizcert_read', { result: 'bad_format' });
    return null;
  }
  const fieldsOf = async (text: string) => (text.trim() ? bizFieldsOf(await p.parse(text)) : null);
  try {
    let got: BizFields | null;
    let via = format === 'pdf' ? 'text' : 'ocr';
    if (format === 'pdf') {
      got = await fieldsOf(await p.pdfText(bytes, { forceOcr: false }));
      if (!usable(got)) {
        via = 'ocr';
        got = await fieldsOf(await p.pdfText(bytes, { forceOcr: true }));
      }
    } else got = await fieldsOf(await p.imageText(bytes));
    if (!usable(got)) {
      log('main.bizcert_read', { format, via, result: 'unreadable' });
      return null;
    }
    log('main.bizcert_read', { format, via, result: 'ok', blanks: blanks(got) });
    return got;
  } catch (e) {
    log('main.bizcert_read', { format, result: codeOf(e) });
    return null;
  } finally {
    bytes.fill(0);
  }
}
