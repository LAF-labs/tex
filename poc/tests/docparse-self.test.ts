// docparse 샌드박스 자기 점검(정적, Electron 없음): 네트워크 0·eval 0을 코드와 설정에서 본다.
// 실행 중 점검(창 안에서 fetch·WebSocket·WebRTC·eval 시도 → 0)은 Electron e2e(apps/desktop/src/docparse-e2e.ts)가 한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const files = (dir: string) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`);
const SANDBOX = files('packages/docparse/src/sandbox');
const MAIN = files('packages/docparse/src');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('docparse 자기 점검: 코드', () => {
  it('샌드박스 모듈은 상대 경로 import만(node:·패키지 없음)', () => {
    for (const f of SANDBOX) {
      for (const m of read(f).matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)) assert.ok(m[1]!.startsWith('./'), `${f}: ${m[1]}`);
    }
  });

  it('샌드박스·규칙 파서에 송신 API·eval·Function·동적 import가 없다', () => {
    const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|sendBeacon|importScripts|eval)\s*\(|new\s+Function\b|\bFunction\s*\(|\bimport\s*\(|\bnew\s+(WebSocket|EventSource|Worker|SharedWorker)\b/;
    for (const f of [...SANDBOX, ...MAIN]) assert.ok(!banned.test(strip(read(f))), f);
  });

  it('규칙 파서(main 쪽)는 node:fs(스키마 파일 읽기)·node:module(ajv) 말고 Node 모듈을 쓰지 않는다', () => {
    for (const f of MAIN) {
      for (const m of read(f).matchAll(/from\s+['"](node:[^'"]+)['"]/g)) assert.ok(['node:fs', 'node:module'].includes(m[1]!) && f.endsWith('schema.ts'), `${f}: ${m[1]}`);
    }
  });

  it('제품 코드는 픽스처(@sax/docparse/fixtures)를 import하지 않는다', () => {
    for (const f of [...MAIN, ...SANDBOX, 'apps/desktop/src/docparse.ts']) assert.ok(!/docparse\/fixtures|\.\/fixtures\//.test(read(f)), f);
  });

  it('모델·송신 패키지를 의존하지 않는다(급여·꾸러미 파일 읽기는 모델을 부르지 않는다, ADR-031·032)', () => {
    const pkg = JSON.parse(read('packages/docparse/package.json')) as { dependencies: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@sax/engine', 'ajv']);
    for (const f of [...MAIN, ...SANDBOX]) assert.ok(!/@sax\/(model|net)/.test(read(f)), f);
  });
});

describe('docparse 자기 점검: 샌드박스 창 설정(ADR-014 결정 1)', () => {
  const src = read('apps/desktop/src/docparse.ts');
  const page = read('apps/desktop/static/docparse/index.html');
  const script = read('apps/desktop/static/docparse/docparse.mjs');

  it('숨김 창, sandbox·contextIsolation·nodeIntegration 끔·devTools 끔·대화상자 끔, WebRTC 비프록시 UDP 금지', () => {
    for (const re of [/show: false/, /sandbox: true/, /contextIsolation: true/, /nodeIntegration: false/, /devTools: false/, /disableDialogs: true/, /setWebRTCIPHandlingPolicy\('disable_non_proxied_udp'\)/]) assert.match(src, re);
  });

  it('차단 파티션: 자기 스킴 밖 요청 취소, 권한 거부, 다운로드 막음, 죽은 프록시', () => {
    for (const re of [/onBeforeRequest\(\(d, cb\) => cb\(\{ cancel:/, /setPermissionRequestHandler\(\(_wc, _p, cb\) => cb\(false\)\)/, /setPermissionCheckHandler\(\(\) => false\)/, /will-download', \(e\) => e\.preventDefault\(\)/, /socks5:\/\/127\.0\.0\.1:9/]) assert.match(src, re);
  });

  it("CSP: 페이지·워커 모두 'unsafe-eval' 없음(wasm만 허용), connect-src는 자기 스킴·blob·data", () => {
    const csp = /content="([^"]+)"/.exec(page)![1]!;
    assert.ok(!csp.includes("'unsafe-eval'") && !csp.includes("'unsafe-inline'"), csp);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src sax-docparse: blob: data:/);
    for (const m of src.matchAll(/"(default-src 'none'[^"]*)"/g)) assert.ok(!m[1]!.includes("'unsafe-eval'"), m[1]);
  });

  it('pdf.js는 6.4.299 고정(eval 경로 없는 판, isEvalSupported:false도 명시), 워커는 직접 띄워 workerPort로', () => {
    const pkg = JSON.parse(read('apps/desktop/package.json')) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies['pdfjs-dist'], '6.4.299');
    assert.match(script, /isEvalSupported: false/);
    assert.match(script, /GlobalWorkerOptions\.workerPort = worker/);
    assert.ok(!/workerSrc/.test(strip(script)), 'workerSrc는 메인 스레드 폴백이 있다');
    assert.match(script, /enableScripting: false/);
  });

  it('tesseract: 저장 없음(cacheMethod none), 언어 데이터는 자기 스킴, blob 워커 없음', () => {
    assert.match(script, /cacheMethod: 'none'/);
    assert.match(script, /workerBlobURL: false/);
    assert.match(script, /langPath: model === 'best_int' \? `\$\{BASE\}lang-best-int` : `\$\{BASE\}lang`/);
    assert.ok(!/https?:\/\//.test(strip(script)), '샌드박스 페이지에 외부 주소가 없다');
  });

  it('샌드박스 순수 모듈은 패키지 dist/sandbox를 자기 스킴 /lib/로 싣는다(정적 파일 복사본 없음)', () => {
    assert.match(src, /dist\/sandbox/);
    assert.match(script, /sax-docparse:\/\/app\/lib\/index\.js/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'apps/desktop/static/docparse-text.mjs')));
  });
});
