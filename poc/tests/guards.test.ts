// 정적 경계: engine의 송신 직접 import 금지(D01 §3), --remote-debugging-port 금지(D05 §3), Chrome 인자 허용 목록, 승인 바 판정(ADR-021).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { buildChromeArgs, chromeEnv } from '@sax/vault';
import { BarGate, buildBarHtml, gateHash, overflowLine, summarize, type GateRequest, type SummaryLine } from '../apps/desktop/src/approval-gate.ts';
import { barBounds, SHELL } from '../apps/desktop/src/shell-layout.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('정적·구성 경계', () => {
  it('eslint: engine에서 http/https/net/undici import와 fetch 사용은 오류', async () => {
    const eslint = new ESLint({ cwd: root });
    const [r] = await eslint.lintText(
      `import http from 'node:http';\nimport { connect } from 'net';\nimport { request } from 'undici';\nexport const f = () => fetch('https://x').then(() => [http, connect, request]);\n`,
      { filePath: path.join(root, 'packages/engine/src/_probe.ts') },
    );
    const ids = r!.messages.map((m) => m.ruleId);
    assert.equal(ids.filter((i) => i === 'no-restricted-imports').length, 3);
    assert.ok(ids.includes('no-restricted-globals'));
    const [ok] = await eslint.lintText(`import { Egress } from '@sax/net';\nexport const e = new Egress();\n`, { filePath: path.join(root, 'packages/engine/src/_probe.ts') });
    assert.deepEqual(ok!.messages, []);
  });

  it('eslint: --remote-debugging-port 문자열은 금지 목록 상수 밖에서 오류', async () => {
    const eslint = new ESLint({ cwd: root });
    const [r] = await eslint.lintText(`export const a = ['--remote-debugging-port=9222'];\n`, { filePath: path.join(root, 'packages/vault/src/_probe.ts') });
    assert.ok(r!.messages.some((m) => m.ruleId === 'no-restricted-syntax'));
  });

  it('Chrome 인자: 허용 목록 3개 + 금지 인자 거부, 환경 변수 화이트리스트', () => {
    assert.deepEqual(buildChromeArgs('/p'), ['--remote-debugging-pipe', '--user-data-dir=/p', '--no-first-run']);
    for (const bad of ['--remote-debugging-port=0', '--remote-allow-origins=*', '--no-sandbox', '--disable-extensions']) assert.throws(() => buildChromeArgs('/p', [bad]));
    const env = chromeEnv({ HOME: '/h', PATH: '/bin', HTTPS_PROXY: 'http://evil', CHROME_LOG_FILE: '/tmp/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  });

  it('승인 바 판정: 무장 지연·재시작, 머무름, 바 안 down→up만, 클릭 활성화 예외, 커서 위장', () => {
    const g = new BarGate(600);
    g.setSize(600, 90);
    const at = { x: 300, y: 45 };
    const move = (t: number, dx = 3) => g.mouse({ type: 'mouseMove', ...at, movementX: dx, movementY: 0 }, t);
    const down = (t: number, p = at) => g.mouse({ type: 'mouseDown', ...p, button: 'left' }, t);
    const up = (t: number, p = at) => g.mouse({ type: 'mouseUp', ...p, button: 'left' }, t);
    g.rearm(1000);
    move(1050);
    assert.deepEqual(down(1100), { kind: 'refused', reason: 'arming' }, '무장 전 down은 거부');
    assert.equal(g.armed(1650), false, '무장 전 down이면 600ms를 다시 센다');
    assert.equal(g.armed(1700), true);
    assert.equal(up(1710), null, '거부된 down의 up은 승인이 아니다');
    g.mouse({ type: 'mouseLeave', x: -1, y: -1 }, 1800);
    move(1900);
    assert.deepEqual(down(1950), { kind: 'refused', reason: 'dwell' }, '들어와 움직인 지 150ms 안의 클릭은 거부');
    assert.equal(down(2060), null);
    assert.equal(up(2070, { x: 300, y: 120 }), null, '바 밖에서 뗀 것은 승인이 아니다');
    assert.equal(g.mouse({ type: 'mouseDown', ...at, button: 'right' }, 2100), null);
    down(2200);
    assert.deepEqual(up(2210), { kind: 'approve' });
    // 멈춘 커서 아래에 바가 뜬 경우: 움직이지 않아도 600ms 뒤에는 된다.
    g.rearm(3000);
    down(3700);
    assert.deepEqual(up(3710), { kind: 'approve' });
    // 창 활성화: 100ms 안 바 클릭은 재무장 없이 판정, 아니면 재무장.
    g.windowActivated(4000);
    down(4050);
    assert.equal(g.activationSettled(4100), false);
    assert.deepEqual(up(4060), { kind: 'approve' });
    g.windowActivated(5000);
    assert.equal(g.activationSettled(5100), true);
    assert.equal(g.armed(5600), false);
    // 커서 위장 중에는 무장하지 않고, 풀리면 재무장한다.
    g.setCursorBlocked(true, 6000);
    assert.equal(g.armed(6000), false);
    g.setCursorBlocked(false, 6100);
    assert.equal(g.armed(6600), false);
    assert.equal(g.armed(6700), true);
  });

  it('승인 바 내용: 요약 줄은 fields에서만, 값 이스케이프, 위험 문자·빈 값 거부, 넘치면 무장 안 함, CSP', () => {
    const base = (over: Record<string, string> = {}) => {
      const v: Record<string, string> = { counterpartName: 'A상사', counterpartBizNo: '2148651233', counterpartEmail: 'tax@bücher.example', totalAmount: '3630000', taxAmount: '330000', '$first.bizNo': 'true', ...over };
      const r = { runId: 'r', gateStepId: 'g', reqId: 'q', docType: 'H-01' as const, fields: Object.entries(v).map(([fieldKey, value]) => ({ fieldKey, value })) };
      return { ...r, actionHash: gateHash(r) } satisfies GateRequest;
    };
    const lines = summarize(base()) as SummaryLine[];
    assert.ok(Array.isArray(lines));
    assert.deepEqual(lines.map((l) => l.label), ['공급받는자', '합계', '받는 이메일']);
    assert.equal(lines[0]!.flag, '처음 거래');
    assert.equal(lines[1]!.pieces.map((p) => p.text).join(''), '3,630,000원 · 세액 330,000원');
    assert.equal(lines[2]!.pieces[1]!.text, '@xn--bcher-kva.example', '국제화 도메인은 punycode');
    assert.deepEqual(summarize(base({ counterpartName: 'A상사\u202e' })), { reason: 'unsafe', label: '공급받는자' });
    assert.deepEqual(summarize(base({ counterpartEmail: '' })), { reason: 'missing', label: '받는 이메일' });
    assert.equal(overflowLine(lines, 600), null);
    assert.equal(overflowLine(lines, 420), '공급받는자');
    const html = buildBarHtml(summarize(base({ counterpartName: '<script>alert(1)</script>' })) as SummaryLine[], 'armed');
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(html, /default-src 'none'; style-src 'self'/);
    assert.ok(!/<button|<a |<input|onclick/i.test(html), '바 안에 작은 버튼·링크가 없다');
  });

  it('승인 바 배치: 창 크기만으로 대화 열 하단·입력창 위, 좁으면 레일 오른쪽부터 창 끝까지 띠', () => {
    const b = barBounds(1280, 820);
    assert.deepEqual(b, { x: SHELL.rail + Math.floor((1280 - SHELL.rail - SHELL.panel - 600) / 2), y: 820 - SHELL.composerReserve - SHELL.gap - SHELL.barHeight, width: 600, height: SHELL.barHeight, band: false });
    const n = barBounds(900, 700);
    assert.equal(n.band, true);
    assert.equal(n.x, SHELL.rail);
    assert.equal(n.width, 900 - SHELL.rail);
  });

  it('앱 CSS에 커스텀·숨김 커서가 없다(커서 위장 방지, ADR-021)', () => {
    const dir = path.join(root, 'apps/desktop/static');
    const css = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css') || f.endsWith('.html'));
    for (const f of css) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /cursor\s*:\s*(url\(|none)/i, f);
  });
});
