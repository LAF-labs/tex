// Electron e2e: ADR-014 승인 창(실제 입력만 인정)과 docparse 샌드박스 OCR. 앱 폴더·키체인을 쓰지 않는다.
// 실행: electron apps/desktop/dist/e2e.js
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { parseBizCert } from '@sax/engine/bizcert';
import { LAYOUT, verifyLocalApproval, type ApprovalCard } from './approval-gate.ts';
import { APPROVAL_SCHEME, openApprovalWindow, type ApprovalWindowHandle } from './approval-window.ts';
import { DOCPARSE_SCHEME, ocrInSandbox } from './docparse.ts';

protocol.registerSchemesAsPrivileged([
  { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: APPROVAL_SCHEME, privileges: { standard: true, secure: true } },
]);
app.setPath('userData', path.join(app.getPath('temp'), `sax-e2e-${process.pid}`));
app.on('window-all-closed', () => {}); // 창이 모두 닫혀도 e2e가 끝날 때까지 유지

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ name, ok, detail });

const card = (): ApprovalCard => ({
  runId: 'e2e', gateStepId: 'g1', actionHash: randomBytes(16).toString('hex'), titleKey: 'demo',
  rows: [{ labelKey: 'buyer', value: '<img src=x onerror=alert(1)>가나상사' }, { labelKey: 'amount', value: '1,000원' }],
});
const center = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

async function waitShown(h: ApprovalWindowHandle): Promise<void> {
  for (let i = 0; i < 100 && !h.win.isVisible(); i++) await sleep(20);
}
function click(h: ApprovalWindowHandle, down: { x: number; y: number }, up = down): void {
  h.win.webContents.sendInputEvent({ type: 'mouseDown', x: down.x, y: down.y, button: 'left', clickCount: 1 });
  h.win.webContents.sendInputEvent({ type: 'mouseUp', x: up.x, y: up.y, button: 'left', clickCount: 1 });
}
const settle = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'pending' as const)]);

async function approvalTests(): Promise<void> {
  const key = new Uint8Array(randomBytes(32));
  // 1) 무장 지연(600ms) 안의 클릭·Enter 단독·버튼 밖/엇갈린 클릭은 무시, 이후 실제 클릭은 승인
  const h = openApprovalWindow(card(), key);
  await waitShown(h);
  check('승인 창은 포커스를 빼앗지 않는다(showInactive)', !h.win.isFocused(), { focused: h.win.isFocused() });
  h.win.focus(); // 무장 타이머 재시작
  await sleep(50);
  click(h, center(LAYOUT.approve));
  check('표시·활성화 후 600ms 안의 클릭 무시', (await settle(h.result, 150)) === 'pending');
  await sleep(700);
  h.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  h.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  check('Enter 단독은 승인이 아니다', (await settle(h.result, 150)) === 'pending');
  click(h, center(LAYOUT.approve), center(LAYOUT.deny));
  check('승인에서 눌러 거절에서 뗀 입력은 무시', (await settle(h.result, 150)) === 'pending');
  click(h, { x: 10, y: 10 });
  check('버튼 밖 클릭은 무시', (await settle(h.result, 150)) === 'pending');
  const html = await h.win.webContents.executeJavaScript('document.documentElement.outerHTML').catch((e: Error) => `blocked: ${e.message}`);
  check('승인 창 페이지 스크립트 실행 불가(또는 값이 텍스트로만 들어감)', typeof html !== 'string' || !html.includes('<img src=x'), String(html).slice(0, 80));
  click(h, center(LAYOUT.approve));
  const r1 = await h.result;
  check('무장 후 승인 버튼 클릭 = approve + LocalApproval 검증', r1.decision === 'approve' && r1.via === 'mouse' && !!r1.approval && verifyLocalApproval(key, r1.approval), r1.decision);
  check('다른 키로는 LocalApproval 검증 실패', !!r1.approval && !verifyLocalApproval(new Uint8Array(32), r1.approval));

  // 2) Alt+Y 조합키 승인, Esc 거절
  const h2 = openApprovalWindow(card(), key);
  await waitShown(h2);
  h2.win.focus();
  await sleep(700);
  h2.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Y', modifiers: ['alt'] });
  const r2 = await h2.result;
  check('Alt+Y = approve', r2.decision === 'approve' && r2.via === 'key', r2);
  const h3 = openApprovalWindow(card(), key);
  await waitShown(h3);
  h3.win.focus();
  await sleep(700);
  click(h3, center(LAYOUT.deny));
  const r3 = await h3.result;
  check('거절 버튼 = deny, LocalApproval 없음', r3.decision === 'deny' && r3.approval === null, r3.decision);
  const h4 = openApprovalWindow(card(), key, 300);
  check('시간 초과 = timeout', (await h4.result).decision === 'timeout');
}

async function docparseTests(): Promise<void> {
  // 등록증 이미지를 숨김 창에서 그려 캡처한다(테스트 입력 생성용).
  const w = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { offscreen: true } });
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:24px;padding:40px;background:#fff">
<h1 style="text-align:center;letter-spacing:12px">사업자등록증</h1><p style="text-align:center">(일반과세자)</p><p style="text-align:center">등록번호 : 220-81-62517</p>
<p>상 호 : 마바사상회</p><p>대 표 자 : 최마바</p><p>개 업 연 월 일 : 2021 년 06 월 30 일</p><p>사업장 소재지 : 부산광역시 해운대구 센텀로 5</p></body>`;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await sleep(300);
  const png = (await w.webContents.capturePage()).toPNG();
  w.destroy();
  const ocr = await ocrInSandbox(new Uint8Array(png));
  const parsed = parseBizCert(ocr.text);
  check('docparse 샌드박스 OCR(kor) → 등록번호·대표자·개업일', parsed.fields.repName === '최마바' && parsed.fields.openDate === '20210630' && (parsed.fields.bizNo === '2208162517' || parsed.bizNoSuggestions.includes('2208162517')), { ms: ocr.ms, confidence: ocr.confidence, fields: parsed.fields });
  const ses = session.fromPartition('sax-docparse');
  const net = await ses.fetch('https://example.com/').then((r) => `status ${r.status}`, (e: Error) => `blocked: ${e.message.slice(0, 60)}`);
  check('docparse 파티션 외부 네트워크 차단', net.startsWith('blocked'), net);
  const bad = await ocrInSandbox(new Uint8Array(0)).then(() => 'accepted', (e: Error) => e.message);
  check('빈 입력 거부', bad === 'input_size', bad);
}

app.whenReady().then(async () => {
  try {
    await approvalTests();
    await docparseTests();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  const out = path.resolve(import.meta.dirname, '../../../reports/raw/e2e-desktop.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
