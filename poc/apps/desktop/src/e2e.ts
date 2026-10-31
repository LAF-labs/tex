// Electron e2e: docparse 샌드박스 OCR. 앱 폴더·키체인을 쓰지 않는다.
// 승인 바(ADR-021) e2e는 shell-e2e.ts(PoC-9)로 옮겼다.
// 실행: electron apps/desktop/dist/e2e.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { parseBizCert } from '@sax/engine/bizcert';
import { DOCPARSE_SCHEME, ocrInSandbox } from './docparse.ts';

protocol.registerSchemesAsPrivileged([{ scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(app.getPath('temp'), `sax-e2e-${process.pid}`));
app.on('window-all-closed', () => {}); // 창이 모두 닫혀도 e2e가 끝날 때까지 유지

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ name, ok, detail });

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
