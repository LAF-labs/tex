import fs from 'node:fs/promises';
import path from 'node:path';
import { formatBizNo, syntheticBizNo } from '@sax/db';
import { BrowserWindow, session, type Session } from 'electron';
import type { EngineHost } from './engine-host.ts';
import { DEMO_COUNTERPARTIES, DEMO_PROFILE } from './fixture-mode.ts';
import { hardenSession, hardenWindow } from './harden.ts';
import { splitVat } from '@sax/chat-core';
import { dayOffset, ymd, type Doc, type DocStore } from './shell-model.ts';
import { demoCerts, SAMPLE_MARK } from './synthetic-certs.ts';
import type { PastRun } from './run-history.ts';
import { NOTE } from './shell-runs.ts';
import { importBytes } from './vault-import.ts';

const SEED_COUNTERPARTIES = [
  { name: '(주)가나다상사', repName: '가나다', email: 'tax@ganada-sangsa.example', item: '사무용품' },
  { name: '라마바물산', repName: '라마바', email: 'acc@ramaba.example', item: '포장재' },
  { name: '사아자디자인', repName: '사아자', email: 'hello@saaja.example', item: '디자인 용역' },
  { name: '차카타푸드(주)', repName: '차카타', email: 'billing@chakata.example', item: '식자재' },
  { name: '파하솔루션', repName: '파하', email: 'tax@paha.example', item: '소프트웨어 라이선스' },
  { name: '견본회계사무소', repName: '김견본', email: 'office@gyeonbon.example', item: '기장 대행' },
].map((c, i) => ({ ...c, bizNo: syntheticBizNo(500 + i) }));

type SeedStatus = 'done' | 'mail_unconfirmed' | 'stopped';

const HISTORY: Array<[number, string, string, number, SeedStatus]> = [
  [-1, '16:20', 'B상사', 550_000, 'done'],
  [-2, '10:05', '(주)가나다상사', 1_200_000, 'done'],
  [-3, '14:40', 'A상사', 3_000_000, 'done'],
  [-5, '09:30', '라마바물산', 880_000, 'mail_unconfirmed'],
  [-6, '17:10', 'C테크', 450_000, 'done'],
  [-8, '11:00', '사아자디자인', 2_500_000, 'done'],
  [-9, '15:25', '차카타푸드(주)', 320_000, 'stopped'],
  [-12, '13:15', '파하솔루션', 1_650_000, 'done'],
  [-14, '10:40', 'B상사', 550_000, 'done'],
  [-17, '16:05', '견본회계사무소', 700_000, 'done'],
  [-20, '09:50', '(주)가나다상사', 980_000, 'mail_unconfirmed'],
  [-23, '14:00', 'A상사', 3_000_000, 'done'],
  [-27, '11:35', '라마바물산', 1_100_000, 'done'],
  [-32, '15:45', 'C테크', 450_000, 'done'],
];

function seedPast(): PastRun[] {
  return HISTORY.map(([d, time, who, supply, status], i) => {
    const day = dayOffset(d);
    const s = splitVat(supply, 'separate');
    const runId = `h${i}`;
    const seq = d === -1 ? '00000123' : String(200 + i).padStart(8, '0');
    const issued = status !== 'stopped';
    return {
      runId, kind: issued ? 'issued' : 'not_issued', who, ...s, day, time,
      approvalNo: issued ? `${day.replaceAll('-', '')}-41000012-${seq}` : null,
      documentId: issued ? `d-${runId}` : null,
      mail: issued ? (status === 'mail_unconfirmed' ? 'unconfirmed' : 'sent') : null,
      note: status === 'mail_unconfirmed' ? NOTE['mail.not_confirmed']! : status === 'stopped' ? NOTE['gate.stopped']! : null,
    };
  });
}

const PAGE = '<!doctype html><meta charset="utf-8"><style>body{font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;margin:48px;color:#111}h1{text-align:center;font-size:24px;letter-spacing:4px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #444;padding:6px 8px;font-size:13px;text-align:left}th{background:#f2f2f2;width:22%}.r{text-align:right}.m{color:#666;font-size:12px}</style><body>';
const won = (n: number) => n.toLocaleString('ko-KR');

function invoiceHtml(o: { date: string; who: string; bizNo: string; rep: string; mail: string; item: string; supply: number; tax: number; approvalNo: string }): string {
  return `${PAGE}<h1>전자세금계산서</h1><p class="m">승인번호 ${o.approvalNo} · 작성일자 ${o.date}</p>
<table><tr><th>공급자</th><td>${DEMO_PROFILE.displayName} (${formatBizNo(DEMO_PROFILE.bizNo)}) · 대표 ${DEMO_PROFILE.repName}</td></tr>
<tr><th>공급받는자</th><td>${o.who} (${formatBizNo(o.bizNo)}) · 대표 ${o.rep}</td></tr><tr><th>받는 이메일</th><td>${o.mail}</td></tr></table>
<table><tr><th>품목</th><th>수량</th><th class="r">공급가액</th><th class="r">세액</th></tr><tr><td>${o.item}</td><td>1</td><td class="r">${won(o.supply)}</td><td class="r">${won(o.tax)}</td></tr>
<tr><th colspan="2">합계금액</th><td class="r" colspan="2">${won(o.supply + o.tax)}원 (영수)</td></tr></table>
<p class="m">PoC 데모가 만든 견본입니다. 국세청에 전송되지 않았습니다.</p>${SAMPLE_MARK}</body>`;
}

function sampleHtml(title: string, rows: Array<[string, string]>): string {
  return `${PAGE}<h1>${title}</h1><table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table><p class="m">PoC 데모 견본입니다. 실제 서류가 아닙니다.</p>${SAMPLE_MARK}</body>`;
}

let pdfSession: Session | null = null;
function renderSession(): Session {
  if (pdfSession) return pdfSession;
  pdfSession = session.fromPartition('sax-demo-pdf');
  pdfSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }));
  hardenSession(pdfSession);
  return pdfSession;
}

export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, session: renderSession() } });
  hardenWindow(w);
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return new Uint8Array(await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    w.destroy();
  }
}

export interface DemoSeed {
  past: PastRun[];
  fill(): Promise<void>;
  issued(doc: Doc, run: { counterparty: { name: string; bizNo: string }; email: { value: string }; item: string; supply: number; tax: number; result: { approvalNo: string } | null }): Promise<void>;
}

export async function startDemoSeed(host: EngineHost, store: DocStore, root: string, itemHints: Record<string, string>): Promise<DemoSeed> {
  const have = new Set(((await host.rpc('db.query.counterparties.list')) as Array<{ bizNo: string }>).map((c) => c.bizNo));
  for (const c of SEED_COUNTERPARTIES) {
    if (!have.has(c.bizNo)) await host.rpc('counterparty.create', { bizNo: c.bizNo, name: c.name, repName: c.repName, email: c.email });
    itemHints[c.bizNo] = c.item;
  }
  const cps = new Map([...DEMO_COUNTERPARTIES, ...SEED_COUNTERPARTIES].map((c) => [c.name, c]));
  const past = seedPast();
  const issued = past.filter((p) => p.kind === 'issued');
  const invoices: Doc[] = issued.map((p) => ({ id: p.documentId!, name: `세금계산서 ${p.who}`, kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: p.day, expiresOn: null, source: '앱이 발급' }));
  const kept = store.docs.filter((d) => d.id === 'd5' || d.id === 'd6');
  store.docs.splice(0, store.docs.length, ...invoices, ...kept);
  const dir = path.join(root, 'demo-samples');

  const write = async (id: string, html: string) => {
    const file = path.join(dir, `${id}.pdf`);
    await fs.writeFile(file, await htmlToPdf(html));
    store.files.set(id, file);
  };
  return {
    past,
    async fill() {
      await fs.mkdir(dir, { recursive: true });
      const me = { name: DEMO_PROFILE.displayName, rep: DEMO_PROFILE.repName, bizNo: DEMO_PROFILE.bizNo };
      const engine = (m: string, p: Record<string, unknown>) => host.rpc(m, p);
      for (const c of demoCerts(ymd(new Date()), me)) await importBytes(await htmlToPdf(c.html), engine);
      for (const p of issued) {
        const c = cps.get(p.who!)!;
        await write(p.documentId!, invoiceHtml({ date: p.day!, who: p.who!, bizNo: c.bizNo, rep: c.repName, mail: c.email, item: c.item, supply: p.supply!, tax: p.tax!, approvalNo: p.approvalNo! }));
      }
      for (const d of kept)
        await write(d.id, sampleHtml(d.docName, [['이름', d.profile === 'business' ? `${DEMO_PROFILE.displayName} (${formatBizNo(DEMO_PROFILE.bizNo)})` : DEMO_PROFILE.repName], ['발급일', d.issuedOn ?? '—'], ['유효기간', d.expiresOn ?? '없음']]));
    },
    async issued(doc, run) {
      if (!run.result) return;
      await fs.mkdir(dir, { recursive: true });
      const c = cps.get(run.counterparty.name);
      await write(doc.id, invoiceHtml({ date: doc.issuedOn ?? dayOffset(0), who: run.counterparty.name, bizNo: run.counterparty.bizNo, rep: c?.repName ?? '', mail: run.email.value, item: run.item, supply: run.supply, tax: run.tax, approvalNo: run.result.approvalNo }));
    },
  };
}
