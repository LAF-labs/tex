// 시연 씨앗(pnpm demo, fixture 모드 + demoSeed만): 견본 거래처·지난 발급 이력·문서함 PDF. e2e는 씨앗 없이 돈다.
// 이름·번호·메일은 모두 가상이다(사업자번호는 체크섬만 맞는 합성 값, 메일은 *.example). 모든 PDF에 "견본" 표시를 얹는다.
// 증명서 PDF는 실제 가져오기와 같은 길(docparse 샌드박스 → 엔진 document.import)로 보관함에 넣는다. 세금계산서·등본 등
// 목업 서류는 견본 PDF 파일만 만들어 둔다(경로는 main 안 MockStore.files에만, 렌더러에 보내지 않는다).
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatBizNo, syntheticBizNo } from '@sax/db';
import { BrowserWindow, session, type Session } from 'electron';
import type { EngineHost } from './engine-host.ts';
import { DEMO_COUNTERPARTIES, DEMO_PROFILE } from './fixture-mode.ts';
import { hardenSession, hardenWindow } from './harden.ts';
import { dayOffset, split, ymd, type Doc, type DocStore } from './shell-model.ts';
import { demoCerts, SAMPLE_MARK } from './synthetic-certs.ts';
import { importBytes } from './vault-import.ts';

/** fixture 기본 3곳(A상사·B상사·C테크)에 더하는 견본 거래처. */
export const SEED_COUNTERPARTIES = [
  { name: '(주)가나다상사', repName: '가나다', email: 'tax@ganada-sangsa.example', item: '사무용품' },
  { name: '라마바물산', repName: '라마바', email: 'acc@ramaba.example', item: '포장재' },
  { name: '사아자디자인', repName: '사아자', email: 'hello@saaja.example', item: '디자인 용역' },
  { name: '차카타푸드(주)', repName: '차카타', email: 'billing@chakata.example', item: '식자재' },
  { name: '파하솔루션', repName: '파하', email: 'tax@paha.example', item: '소프트웨어 라이선스' },
  { name: '견본회계사무소', repName: '김견본', email: 'office@gyeonbon.example', item: '기장 대행' },
].map((c, i) => ({ ...c, bizNo: syntheticBizNo(500 + i) }));

export type HistoryStatus = 'done' | 'attention' | 'stopped';
/** 활동 기록·거래처 이력에 보이는 지난 세금계산서(이 PC에서 한 일). */
export interface HistoryItem {
  id: string;
  date: string;
  time: string;
  who: string;
  title: '세금계산서';
  supply: number;
  tax: number;
  total: number;
  approvalNo: string | null;
  mail: string;
  status: HistoryStatus;
}

// [며칠 전, 시각, 거래처, 공급가액, 상태]. 하루 전 B상사 건은 대화 타임라인의 지난 카드(seedTimeline)와 같다.
const HISTORY: Array<[number, string, string, number, HistoryStatus]> = [
  [-1, '16:20', 'B상사', 550_000, 'done'],
  [-2, '10:05', '(주)가나다상사', 1_200_000, 'done'],
  [-3, '14:40', 'A상사', 3_000_000, 'done'],
  [-5, '09:30', '라마바물산', 880_000, 'attention'],
  [-6, '17:10', 'C테크', 450_000, 'done'],
  [-8, '11:00', '사아자디자인', 2_500_000, 'done'],
  [-9, '15:25', '차카타푸드(주)', 320_000, 'stopped'],
  [-12, '13:15', '파하솔루션', 1_650_000, 'done'],
  [-14, '10:40', 'B상사', 550_000, 'done'],
  [-17, '16:05', '견본회계사무소', 700_000, 'done'],
  [-20, '09:50', '(주)가나다상사', 980_000, 'attention'],
  [-23, '14:00', 'A상사', 3_000_000, 'done'],
  [-27, '11:35', '라마바물산', 1_100_000, 'done'],
  [-32, '15:45', 'C테크', 450_000, 'done'],
];

export function seedHistory(): HistoryItem[] {
  const mails = new Map([...DEMO_COUNTERPARTIES, ...SEED_COUNTERPARTIES].map((c) => [c.name, c.email]));
  return HISTORY.map(([d, time, who, supply, status], i) => {
    const date = dayOffset(d);
    const s = split(supply, 'separate');
    // 하루 전 B상사 건은 타임라인 지난 카드와 같은 승인번호(seedTimeline)
    const seq = d === -1 ? '00000123' : String(200 + i).padStart(8, '0');
    return { id: `h${i}`, date, time, who, title: '세금계산서', ...s, approvalNo: status === 'stopped' ? null : `${date.replaceAll('-', '')}-41000012-${seq}`, mail: mails.get(who) ?? '', status };
  });
}

const PAGE = '<!doctype html><meta charset="utf-8"><style>body{font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;margin:48px;color:#111}h1{text-align:center;font-size:24px;letter-spacing:4px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #444;padding:6px 8px;font-size:13px;text-align:left}th{background:#f2f2f2;width:22%}.r{text-align:right}.m{color:#666;font-size:12px}</style><body>';
const won = (n: number) => n.toLocaleString('ko-KR');

/** 견본 전자세금계산서(발급본) 한 장. */
export function invoiceHtml(o: { date: string; who: string; bizNo: string; rep: string; mail: string; item: string; supply: number; tax: number; approvalNo: string }): string {
  return `${PAGE}<h1>전자세금계산서</h1><p class="m">승인번호 ${o.approvalNo} · 작성일자 ${o.date}</p>
<table><tr><th>공급자</th><td>${DEMO_PROFILE.displayName} (${formatBizNo(DEMO_PROFILE.bizNo)}) · 대표 ${DEMO_PROFILE.repName}</td></tr>
<tr><th>공급받는자</th><td>${o.who} (${formatBizNo(o.bizNo)}) · 대표 ${o.rep}</td></tr><tr><th>받는 이메일</th><td>${o.mail}</td></tr></table>
<table><tr><th>품목</th><th>수량</th><th class="r">공급가액</th><th class="r">세액</th></tr><tr><td>${o.item}</td><td>1</td><td class="r">${won(o.supply)}</td><td class="r">${won(o.tax)}</td></tr>
<tr><th colspan="2">합계금액</th><td class="r" colspan="2">${won(o.supply + o.tax)}원 (영수)</td></tr></table>
<p class="m">PoC 데모가 만든 견본입니다. 국세청에 전송되지 않았습니다.</p>${SAMPLE_MARK}</body>`;
}

/** 목업 서류(등본·중소기업확인서 등)의 견본 한 장. */
function sampleHtml(title: string, rows: Array<[string, string]>): string {
  return `${PAGE}<h1>${title}</h1><table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table><p class="m">PoC 데모 견본입니다. 실제 서류가 아닙니다.</p>${SAMPLE_MARK}</body>`;
}

let pdfSession: Session | null = null;
/** PDF를 그리는 메모리 세션: data: 페이지만 받고 나머지 요청은 모두 막는다(셸 기본 세션은 sax-shell:만 받아 data:를 막는다). */
function renderSession(): Session {
  if (pdfSession) return pdfSession;
  pdfSession = session.fromPartition('sax-demo-pdf');
  pdfSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }));
  hardenSession(pdfSession);
  return pdfSession;
}

/** HTML을 PDF로(보이지 않는 창, 스크립트 끔). */
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
  history: HistoryItem[];
  /** 견본 PDF를 만들고 증명서를 보관함에 넣는다(몇 초). 창을 띄운 뒤 뒤에서 돌린다. */
  fill(): Promise<void>;
  /** 실행이 발급을 마치면 그 발급본 견본 PDF를 만든다. */
  issued(doc: Doc, run: { counterparty: { name: string; bizNo: string }; email: { value: string }; item: string; supply: number; tax: number; result: { approvalNo: string } | null }): Promise<void>;
}

/**
 * 빈 데모 DB에 견본 거래처를 넣고(엔진 명령), 목업 문서함을 견본 서류로 바꾼다. 거래처의 지난 품목은 itemHints에 더한다.
 * PDF·보관함 가져오기는 fill()에서 한다(창을 먼저 띄우게).
 */
export async function startDemoSeed(host: EngineHost, store: DocStore, root: string, itemHints: Record<string, string>): Promise<DemoSeed> {
  const have = new Set(((await host.rpc('db.query.counterparties.list')) as Array<{ bizNo: string }>).map((c) => c.bizNo));
  for (const c of SEED_COUNTERPARTIES) {
    if (!have.has(c.bizNo)) await host.rpc('counterparty.create', { bizNo: c.bizNo, name: c.name, repName: c.repName, email: c.email });
    itemHints[c.bizNo] = c.item;
  }
  const cps = new Map([...DEMO_COUNTERPARTIES, ...SEED_COUNTERPARTIES].map((c) => [c.name, c]));
  const history = seedHistory();
  // 지난 발급본(완료·확인 필요)이 문서함 세금계산서가 된다. 증명서 목업(d1·d2)과 예전 계산서 목업(d3·d4)은 견본으로 바꾼다.
  const invoices: Doc[] = history
    .filter((h) => h.approvalNo)
    .map((h) => ({ id: `d-${h.id}`, name: `세금계산서 · ${h.who}`, kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: h.date, expiresOn: null, source: '앱이 발급' }));
  const kept = store.docs.filter((d) => d.id === 'd5' || d.id === 'd6');
  store.docs.splice(0, store.docs.length, ...invoices, ...kept);
  const dir = path.join(root, 'demo-samples');

  const write = async (id: string, html: string) => {
    const file = path.join(dir, `${id}.pdf`);
    await fs.writeFile(file, await htmlToPdf(html));
    store.files.set(id, file);
  };
  return {
    history,
    async fill() {
      await fs.mkdir(dir, { recursive: true });
      const me = { name: DEMO_PROFILE.displayName, rep: DEMO_PROFILE.repName, bizNo: DEMO_PROFILE.bizNo };
      const engine = (m: string, p: Record<string, unknown>) => host.rpc(m, p);
      for (const c of demoCerts(ymd(new Date()), me)) await importBytes(await htmlToPdf(c.html), engine);
      for (const h of history) {
        if (!h.approvalNo) continue;
        const c = cps.get(h.who)!;
        await write(`d-${h.id}`, invoiceHtml({ date: h.date, who: h.who, bizNo: c.bizNo, rep: c.repName, mail: h.mail, item: c.item, supply: h.supply, tax: h.tax, approvalNo: h.approvalNo }));
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
