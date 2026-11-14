// 세무사 꾸러미(08 D-05, 대표 지시 2026-11-14 "끊김없이"): 한 달치 발급 세금계산서 목록·PDF·증명서·받을 돈을 한 폴더와 zip으로 만든다.
// - 재료는 로컬뿐이다: 실행 이력(원장 기준 PastRun), 문서함(보관함 서류), 받을 돈(엔진 bank). 서버로 보내지 않는다. 보내기는 사용자가 macOS 공유 시트에서 한다.
// - 같은 달을 다시 만들면 같은 자리에 새로 쓴다(폴더를 지우고 다시 쓴다). 만드는 데 확인 단계가 없다.
// - 엔진 @sax/bundle 내보내기(암호 엑셀 + AES ZIP)는 쓰지 않는다. 받는 쪽이 암호를 따로 받아야 하고 macOS 기본 압축 해제로 못 연다.
// - 폴더는 앱 데이터(userData) 아래다. 문서·다운로드 폴더에 쓰면 macOS가 폴더 접근 허용 창을 띄운다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { Doc } from './shell-model.ts';
import type { PastRun } from './run-history.ts';

/** YYYY-MM */
export type PackMonth = string;

export interface PackInvoice {
  runId: string;
  day: string | null;
  who: string | null;
  supply: number | null;
  tax: number | null;
  total: number | null;
  approvalNo: string | null;
  mail: PastRun['mail'];
  /** 꾸러미에 넣은 PDF 파일 이름. 없으면 null(빠진 것) */
  pdf: string | null;
}

/** 빠진 것 한 줄. 종류가 화면 문구와 순서를 정한다(GAP_LABEL). */
export type PackGapKind = 'unsure' | 'no_pdf' | 'mail_unconfirmed' | 'not_issued' | 'no_bank';
export interface PackGap {
  kind: PackGapKind;
  who: string | null;
  day: string | null;
  total: number | null;
}

export interface PackReceivable {
  who: string;
  writtenOn: string;
  remaining: number | null;
}

export interface PackSummary {
  month: PackMonth;
  /** 화면 글: "10월" */
  label: string;
  invoices: PackInvoice[];
  totals: { count: number; supply: number; tax: number; total: number };
  certs: Array<{ id: string; name: string; issuedOn: string | null; file: string | null }>;
  /** 계좌 연결 전이면 null */
  receivables: { count: number; total: number; rows: PackReceivable[] } | null;
  gaps: PackGap[];
  /** 만든 zip 이름과 폴더 안 파일 목록(꾸러미 기준 상대 경로) */
  zipName: string;
  files: string[];
  madeAt: string;
}

export const GAP_LABEL: Record<PackGapKind, string> = {
  unsure: '발급됐는지 확인 필요',
  no_pdf: 'PDF 없음',
  mail_unconfirmed: '메일 확인 못 함',
  not_issued: '발급 안 된 시도',
  no_bank: '계좌 연결 전이라 받을 돈이 빠졌어요',
};
const GAP_ORDER: PackGapKind[] = ['unsure', 'no_pdf', 'mail_unconfirmed', 'not_issued', 'no_bank'];

export interface PackPorts {
  past(): Promise<PastRun[]>;
  docs(): Promise<Doc[]>;
  /** 문서 id → PDF 경로. 없으면 던진다 */
  docFile(id: string): Promise<string>;
  receivables(): Promise<Array<{ counterparty: string; date: string; total: number | null }> | null>;
  businessName(): string | null;
  /** 꾸러미를 쓰는 폴더(userData/세무사 꾸러미) */
  outRoot: string;
  now?: () => Date;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPackMonth = (m: unknown): m is PackMonth => typeof m === 'string' && MONTH_RE.test(m);

/** KST 오늘 YYYY-MM-DD → 지난달·이번 달 */
export function packMonths(today: string): { last: PackMonth; this: PackMonth } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { last, this: today.slice(0, 7) };
}

/** 대화 L0 규칙(엔진 l0/rules.ts bundle.monthly와 같은 꼴) */
const PACK_RE = /꾸러미|세무사\s*.{0,8}(자료|보낼|넘길|묶)/;
/** 대화 문장이 꾸러미 요청이면 그 달(이번 달·N월이 없으면 지난달), 아니면 null */
export function packAsk(text: string, today: string): PackMonth | null {
  if (!PACK_RE.test(text)) return null;
  const { last, this: cur } = packMonths(today);
  if (/이번\s*달|이달/.test(text)) return cur;
  const n = /(\d{1,2})\s*월/.exec(text);
  if (n) {
    const mm = Number(n[1]);
    if (mm >= 1 && mm <= 12) {
      const y = Number(today.slice(0, 4));
      const yy = mm > Number(today.slice(5, 7)) ? y - 1 : y;
      return `${yy}-${String(mm).padStart(2, '0')}`;
    }
  }
  return last;
}

const SAFE = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '이름 없음';
const ymd = (d: string | null) => (d ? d.replaceAll('-', '') : '날짜모름');
const MAIL_KO = { sent: '보냄', unconfirmed: '확인 못 함' } as const;
const KIND_KO: Record<PastRun['kind'], string> = { issued: '발급됨', unsure: '확인 필요', not_issued: '발급 안 됨', stopped_before_gate: '승인 전 멈춤' };

/** 엑셀이 수식으로 읽지 않게(=+-@로 시작하면 작은따옴표) 감싸고 따옴표를 겹친다 */
const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = /^[=+\-@\t\r\n＝＋－＠]/u.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
/** 엑셀이 한글을 바로 읽는 CSV(UTF-8 BOM, CRLF) */
const csv = (rows: Array<Array<string | number | null | undefined>>) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

export class AccountantPack {
  private readonly ports: PackPorts;
  constructor(ports: PackPorts) {
    this.ports = ports;
  }

  dir(month: PackMonth): string {
    return path.join(this.ports.outRoot, month);
  }

  zipPath(month: PackMonth): string {
    return path.join(this.ports.outRoot, this.zipName(month));
  }

  private zipName(month: PackMonth): string {
    const biz = this.ports.businessName();
    return `세무사 꾸러미 ${month}${biz ? ` ${SAFE(biz)}` : ''}.zip`;
  }

  /** 그 달 꾸러미를 폴더와 zip으로 새로 쓰고 요약을 돌려준다. */
  async make(month: PackMonth): Promise<PackSummary> {
    const [past, docs, recv] = await Promise.all([this.ports.past(), this.ports.docs(), this.ports.receivables().catch(() => null)]);
    const inMonth = past.filter((p) => p.day?.startsWith(month)).sort((a, b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`));
    const dir = this.dir(month);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.join(dir, '세금계산서 PDF'), { recursive: true });
    const files: Array<{ rel: string; bytes: Buffer }> = [];
    const put = async (rel: string, bytes: Buffer) => {
      await fs.writeFile(path.join(dir, rel), bytes);
      files.push({ rel, bytes });
    };
    const fileOf = async (id: string | null): Promise<string | null> => {
      if (!id) return null;
      const f = await this.ports.docFile(id).catch(() => null);
      return f && path.extname(f).toLowerCase() === '.pdf' && (await exists(f)) ? f : null;
    };

    const gaps: PackGap[] = [];
    const invoices: PackInvoice[] = [];
    const usedNames = new Set<string>();
    for (const p of inMonth) {
      const g = { who: p.who, day: p.day, total: p.total };
      if (p.kind === 'unsure') gaps.push({ kind: 'unsure', ...g });
      if (p.kind === 'not_issued' || p.kind === 'stopped_before_gate') gaps.push({ kind: 'not_issued', ...g });
      if (p.kind !== 'issued') continue;
      const src = await fileOf(p.documentId);
      let pdf: string | null = null;
      if (src) {
        let name = `${ymd(p.day)}_${SAFE(p.who ?? '거래처')}_${(p.approvalNo ?? p.runId).slice(-8)}.pdf`;
        for (let i = 2; usedNames.has(name); i++) name = name.replace(/(_\d+)?\.pdf$/, `_${i}.pdf`);
        usedNames.add(name);
        pdf = `세금계산서 PDF/${name}`;
        await put(pdf, await fs.readFile(src));
      } else gaps.push({ kind: 'no_pdf', ...g });
      if (p.mail !== 'sent') gaps.push({ kind: 'mail_unconfirmed', ...g });
      invoices.push({ runId: p.runId, day: p.day, who: p.who, supply: p.supply, tax: p.tax, total: p.total, approvalNo: p.approvalNo, mail: p.mail, pdf });
    }
    const sum = (k: 'supply' | 'tax' | 'total') => invoices.reduce((s, v) => s + (v[k] ?? 0), 0);
    const totals = { count: invoices.length, supply: sum('supply'), tax: sum('tax'), total: sum('total') };

    await put(
      `세금계산서 목록 ${month}.csv`,
      Buffer.from(
        csv([
          ['작성일', '승인번호', '거래처', '공급가액', '세액', '합계', '메일', 'PDF', '상태'],
          ...inMonth.map((p) => {
            const v = invoices.find((x) => x.runId === p.runId);
            return [p.day, p.approvalNo, p.who, p.supply, p.tax, p.total, p.mail ? MAIL_KO[p.mail] : '', v ? (v.pdf ? '있음' : '없음') : '', KIND_KO[p.kind]];
          }),
          ['합계', '', `${totals.count}건`, totals.supply, totals.tax, totals.total, '', '', ''],
        ]),
      ),
    );

    const certs: PackSummary['certs'] = [];
    const certDocs = docs.filter((d) => d.kind === '증명서' && d.issuedOn?.startsWith(month));
    if (certDocs.length) await fs.mkdir(path.join(dir, '증명서'), { recursive: true });
    for (const d of certDocs) {
      const src = await fileOf(d.id);
      let file: string | null = null;
      if (src) {
        file = `증명서/${ymd(d.issuedOn)}_${SAFE(d.docName || d.name)}_${d.id.slice(-6)}.pdf`;
        await put(file, await fs.readFile(src));
      }
      certs.push({ id: d.id, name: d.docName || d.name, issuedOn: d.issuedOn, file });
    }

    let receivables: PackSummary['receivables'] = null;
    if (recv) {
      const rows = recv.map((r) => ({ who: r.counterparty, writtenOn: r.date, remaining: r.total })).sort((a, b) => a.writtenOn.localeCompare(b.writtenOn));
      receivables = { count: rows.length, total: rows.reduce((s, r) => s + (r.remaining ?? 0), 0), rows };
      await put(
        '받을 돈.csv',
        Buffer.from(csv([['작성일', '거래처', '못 받은 금액'], ...rows.map((r) => [r.writtenOn, r.who, r.remaining]), ['합계', `${rows.length}건`, receivables.total]])),
      );
    } else gaps.push({ kind: 'no_bank', who: null, day: null, total: null });
    gaps.sort((a, b) => GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind) || (a.day ?? '').localeCompare(b.day ?? ''));

    const madeAt = (this.ports.now?.() ?? new Date()).toISOString();
    const label = `${Number(month.slice(5))}월`;
    const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
    const readme = [
      `세무사 꾸러미 ${month}${this.ports.businessName() ? ` · ${this.ports.businessName()}` : ''}`,
      '',
      `발급한 세금계산서 ${totals.count}건 · 공급가액 ${won(totals.supply)} · 세액 ${won(totals.tax)} · 합계 ${won(totals.total)}`,
      `증명서 ${certs.length}건`,
      receivables ? `받을 돈 ${receivables.count}건 · ${won(receivables.total)} (만든 날 기준)` : '받을 돈: 계좌 연결 전이라 넣지 않았어요',
      '',
      gaps.length ? '빠진 것' : '빠진 것 없음',
      ...gaps.map((g) => `- ${GAP_LABEL[g.kind]}${g.who ? ` · ${g.who}` : ''}${g.day ? ` · ${g.day}` : ''}${g.total !== null ? ` · ${won(g.total)}` : ''}`),
    ].join('\r\n');
    await put('요약.txt', Buffer.from('﻿' + readme + '\r\n'));

    const zipName = this.zipName(month);
    const top = zipName.replace(/\.zip$/, '');
    await fs.writeFile(path.join(this.ports.outRoot, zipName), zip(files.map((f) => ({ name: `${top}/${f.rel}`, bytes: f.bytes })), new Date(madeAt)));
    return { month, label, invoices, totals, certs, receivables, gaps, zipName, files: files.map((f) => f.rel), madeAt };
  }
}

// ---- zip(PKZIP 2.0, deflate, UTF-8 이름). macOS 압축 해제·Windows 탐색기가 바로 연다 ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: Array<{ name: string; bytes: Uint8Array }>, at: Date): Buffer {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = deflateRawSync(e.bytes);
    const crc = crc32(e.bytes);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(e.bytes.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(e.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** 렌더러 요청 표(ipc.ts SHELL_METHODS에 펼친다). month는 YYYY-MM이고 처리기가 다시 본다. */
const MONTH = { t: 'string', max: 7, required: true } as const;
export const PACK_SHELL_METHODS = {
  'pack.make': { month: MONTH },
  'pack.reveal': { month: MONTH },
  'pack.share': { month: MONTH },
} as const;
