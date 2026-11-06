// AUDIT-D 패키지 D(데스크톱·시험 하네스): 하드닝 진입점, 자식 env, 금고가 부르는 비밀 창, 사용자 동작 결속, 활성화 예외,
// 중복 경고 상태별 표시, 작성일 조각, 바 팔레트, 스모크 임시 루트, 단일 인스턴스, docparse 대화상자, PDF 암호 재시도, 셸 문구.
// Electron을 import하는 모듈은 불러오지 않는다(판정 모듈만 시험하고 Electron 쪽은 소스로 확인한다).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { GateField } from '@sax/engine/gate';
import {
  ACTION_TEXT_DUP,
  ACTION_TEXT_DUP_COMMITTED,
  actionText,
  BAR_PALETTE_DEFAULT,
  BarGate,
  barCss,
  barPalette,
  buildBarHtml,
  HANDOFF_RETURN_MS,
  HandoffMark,
  kstToday,
  summarize,
  type SummaryLine,
} from '../apps/desktop/src/approval-gate.ts';
import { childEnv } from '../apps/desktop/src/child-env.ts';
import { GestureClock, isGestureKey, RateWindow } from '../apps/desktop/src/gesture.ts';
import { today as fixtureToday } from '../apps/desktop/src/h01-fixture.ts';
import { DEBUG_SWITCHES, findDebugSwitch } from '../apps/desktop/src/harden.ts';
import { MAX_TRIES, PICK_TTL_MS, PickStore } from '../apps/desktop/src/pick-store.ts';
import { parseSecretNeeded, secretPageHtml, secretTitle, SecretWindowCoordinator } from '../apps/desktop/src/secret-labels.ts';
import { interpret, type Counterparty } from '../apps/desktop/src/shell-mock.ts';
import { fatalText, NOTE, ShellRuns, vaultNotice } from '../apps/desktop/src/shell-runs.ts';
import { loadTokens } from '../apps/desktop/src/shell-tokens.ts';
import { smokeRootPlan } from '../apps/desktop/src/smoke-plan.ts';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.join(root, 'apps/desktop/src');
const src = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));

const fieldsOf = (v: Record<string, string>) => ({ fields: Object.entries(v).map(([fieldKey, value]) => ({ fieldKey, value })) as GateField[] });
const base = (over: Record<string, string> = {}) =>
  fieldsOf({ counterpartName: 'A상사', counterpartBizNo: '2148651233', counterpartEmail: 'tax@asangsa.example', totalAmount: '3630000', taxAmount: '330000', ...over });

const CPS: Counterparty[] = [{ id: 'cp-a', name: 'A상사', bizNo: '2148651233', rep: '이에이', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];
class FakeHost extends EventEmitter {
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(): Promise<unknown> {
    return {};
  }
}

describe('audit-d: D1 하드닝 진입점(N-24·N-68)', () => {
  it("no 'vault-port' string under apps/desktop/src", () => {
    for (const f of srcFiles) assert.ok(!src(f).includes('vault-port'), f);
  });

  it('every file that constructs BrowserWindow calls hardenWindow (e2e 제외)', () => {
    const makers = srcFiles.filter((f) => !f.endsWith('e2e.ts') && /new BrowserWindow\(/.test(src(f)));
    assert.deepEqual(makers.sort(), ['demo-seed.ts', 'docparse.ts', 'main.ts', 'secret-window.ts', 'shell-app.ts']);
    for (const f of makers) assert.match(src(f), /hardenWindow\(/, f);
  });

  it('main.ts and shell-app.ts both import harden.ts and call hardenApp; ApprovalBar checks switches first', () => {
    for (const f of ['main.ts', 'shell-app.ts']) {
      assert.match(src(f), /from '\.\/harden\.ts'/, f);
      assert.match(src(f), /hardenApp\(app,/, f);
    }
    assert.match(src('approval-bar.ts'), /constructor\([^)]*\) \{\s*(\/\/[^\n]*\n\s*)*assertNoDebugSwitches\(app\);/);
    // 개발 콘솔의 옛 수동 경로가 없다.
    for (const m of ['browser.open', 'secret.openInput', 'approval.demo', 'startProcesses']) assert.ok(!src('main.ts').includes(m), m);
  });

  it('DEBUG_SWITCHES has all nine switches; Chromium 스위치와 Node 인자를 모두 본다', () => {
    assert.deepEqual([...DEBUG_SWITCHES].sort(), ['enable-logging', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags', 'log-file', 'remote-allow-origins', 'remote-debugging-pipe', 'remote-debugging-port']);
    assert.equal(findDebugSwitch(() => false, ['electron', 'shell.js']), null);
    assert.equal(findDebugSwitch(() => false, ['--inspect=0']), 'inspect');
    assert.equal(findDebugSwitch(() => false, ['--inspector-x']), null, '이름 앞부분만 같은 인자는 아니다');
    assert.equal(findDebugSwitch((s) => s === 'remote-debugging-port'), 'remote-debugging-port');
  });

  it('pnpm start:hometax = shell.js, 제품 진입점 shell.ts는 hometax 엔진만 띄운다(fixture·시연 연결 없음, ADR-035 W-7)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['start:hometax'], 'pnpm build && electron apps/desktop/dist/shell.js --portal=hometax');
    // 가짜 홈택스·시연은 demo-shell.ts(pnpm demo)에만 있다. 제품 진입점에는 그 길이 없다.
    assert.ok(!/dev:|DEMO_DEV|demo-|fixture/.test(src('shell.ts').replace(/^\/\/.*$/gm, '')));
    assert.equal(pkg.scripts.demo, 'pnpm build && electron apps/desktop/dist/demo-shell.js');
    assert.match(src('shell.ts'), /engine: \{ portal: \{ kind: 'hometax' \} \}/);
    assert.match(src('shell.ts'), /prepareLayout\(root\)/);
  });
});

describe('audit-d: D2 자식 env(N-23)', () => {
  it('childEnv drops DEBUG, DEBUG_FILE, NODE_OPTIONS, HTTPS_PROXY, OPENAI_API_KEY, SSLKEYLOGFILE and keeps LOCALAPPDATA, PATH', () => {
    const env = childEnv({
      PATH: '/bin', LOCALAPPDATA: 'C:\\L', DEBUG: 'pw:protocol', DEBUG_FILE: '/tmp/x', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://evil', OPENAI_API_KEY: 'sk-x', SSLKEYLOGFILE: '/tmp/k',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: '/ca', PWDEBUG: '1', ELECTRON_RUN_AS_NODE: '1',
    });
    assert.deepEqual(env, { PATH: '/bin', LOCALAPPDATA: 'C:\\L' });
    // Linux X11·xvfb 화면 인증은 넘긴다(금고가 띄우는 Chrome이 DISPLAY에 붙으려면 필요하다).
    assert.deepEqual(childEnv({ DISPLAY: ':99', XAUTHORITY: '/tmp/xvfb-run.x/Xauthority', DEBUG: '1' }), { DISPLAY: ':99', XAUTHORITY: '/tmp/xvfb-run.x/Xauthority' });
  });

  it('every utilityProcess.fork call passes env and execArgv', () => {
    let n = 0;
    for (const f of srcFiles) {
      for (const m of src(f).matchAll(/utilityProcess\.fork\(([^;]*)\);/g)) {
        n++;
        assert.match(m[1]!, /env: childEnv\(\)/, `${f}: ${m[0]}`);
        assert.match(m[1]!, /execArgv: \[\]/, `${f}: ${m[0]}`);
      }
    }
    assert.equal(n, 2, '엔진·금고 두 곳(engine-host.ts)');
  });
});

describe('audit-d: D3 금고가 부르는 비밀 창(N-44·N-11)', () => {
  it('secretTitle returns fixed labels and throws on unknown kind', () => {
    assert.equal(secretTitle('cert_password'), '금고 · 공동인증서 비밀번호');
    assert.equal(secretTitle('portal_password'), '금고 · 홈택스 비밀번호');
    assert.equal(secretTitle('security_card'), '금고 · 보안카드 번호');
    for (const bad of ['toString', '__proto__', 'otp', '']) assert.throws(() => secretTitle(bad), /unknown_secret_kind/, bad);
  });

  it('coordinator opens one window at a time and ignores secret.needed for a runId that is not active', () => {
    const active = new Set(['run-a', 'run-b']);
    const c = new SecretWindowCoordinator((id) => active.has(id));
    const need = (o: Record<string, unknown> = {}) => ({ runId: 'run-a', targetId: 'T1', kind: 'cert_password', scope: 'business', ...o });
    assert.equal(c.request(need({ runId: 'run-x' })), null, '활성 실행이 아니면 열지 않는다');
    assert.equal(c.request(need({ kind: 'otp' })), null, '표에 없는 종류');
    assert.equal(c.request(need({ scope: 'all' })), null);
    assert.equal(c.request(need({ kind: 'security_card', row: 36 })), null, '보안카드 칸은 1~35');
    assert.deepEqual(c.request(need()), { runId: 'run-a', targetId: 'T1', kind: 'cert_password', scope: 'business' });
    assert.equal(c.request(need({ runId: 'run-b' })), null, '열린 창이 있으면 두 번째는 지금 열지 않는다');
    assert.equal(c.request(need({ kind: 'security_card', row: 7 })), null, '대신 마지막 요청을 든다');
    const next = c.closed();
    assert.equal(next?.row, 7, '창이 닫히면 든 요청을 넘긴다');
    assert.equal(c.closed(), null, '한 번만');
    assert.deepEqual(c.request(next)?.row, 7);
    assert.equal(parseSecretNeeded(null), null);
  });

  it('secret page: 라벨·첫 줄·고정 문구는 main 표에서, 프로필 이름은 텍스트로만', () => {
    const html = secretPageHtml({ runId: 'run-a', kind: 'security_card', scope: 'business', row: 12 }, '<img src=x onerror=1>가나다');
    assert.match(html, /<title>금고 · 보안카드 번호<\/title>/);
    assert.match(html, /세금계산서 발급 · 홈택스 · &lt;img src=x onerror=1&gt;가나다/);
    assert.match(html, /앱은 대화창 안에서 비밀번호·카드 번호를 묻지 않아요\./);
    assert.match(html, /data-kind="security_card" data-scope="business" data-row="12"/);
    assert.match(html, /default-src 'none'; script-src 'self'/);
  });

  it('secret.html is served only by the shell protocol', () => {
    assert.ok(!fs.existsSync(path.join(root, 'apps/desktop/static/secret.html')), '개발 콘솔 정적 비밀 창 없음');
    assert.ok(!/secret/.test(src('main.ts').replace(/secretInput|Secret/g, '')), 'main.ts는 비밀 창을 제공하지 않는다');
    assert.match(src('shell-app.ts'), /p === '\/secret\.html'/);
    // 렌더러 IPC에 비밀 창 명령이 없다. 창은 금고 secret.needed로만 열린다.
    assert.ok(!src('shell-app.ts').includes("'secret.openInput'"));
    assert.match(src('shell-app.ts'), /name === 'secret\.needed'/);
    assert.match(src('secret-window.ts'), /modal: true/);
    assert.match(src('secret-window.ts'), /disableDialogs: true/);
    assert.match(src('secret-window.ts'), /setContentProtection\(true\)/);
  });
});

describe('audit-d: D4 사용자 동작 결속(N-27)', () => {
  it('GestureClock rejects a command 2.1s after the last input', () => {
    const g = new GestureClock();
    assert.equal(g.within(1000, 2000), false, '입력이 없으면 거부');
    g.note(1000);
    assert.equal(g.within(3000, 2000), true);
    assert.equal(g.within(3100, 2000), false);
    assert.equal(g.within(900, 2000), false, '입력보다 앞선 시각은 거부');
    assert.equal(isGestureKey({ type: 'keyDown', key: 'Enter' }), true);
    assert.equal(isGestureKey({ type: 'keyDown', key: ' ', control: true }), false);
    assert.equal(isGestureKey({ type: 'keyDown', key: 'a' }), false);
  });

  it('RateWindow allows 3 per 60s and refuses the 4th', () => {
    const r = new RateWindow(3, 60_000);
    assert.deepEqual([r.take(0), r.take(10), r.take(20), r.take(30)], [true, true, true, false]);
    assert.equal(r.take(60_000), true, '창이 지나면 다시');
  });

  it('셸 처리기: run.prepare 2초·docs.import(pick)·docs.open 3초 결속, 대화상자는 메인 창 부모', () => {
    const s = src('shell-app.ts');
    assert.match(s, /'run\.prepare': \(p\) => \{\s*needGesture\(2_000\);/);
    assert.match(s, /if \(typeof p\.pickId !== 'string'\) needGesture\(3_000\);/);
    assert.match(s, /'docs\.open': docsCall\(async \(p\) => \{\s*needGesture\(3_000\);/);
    assert.match(s, /importPdf\(params, engine, win\)/);
    assert.match(src('main.ts'), /case 'ocr\.bizcert': \{[\s\S]*?needGesture\(\);/);
  });

  it('게이트 없이 끝난 실행 연속 3회면 잠시 준비를 받지 않는다(게이트가 뜨면 풀림)', async () => {
    let now = 0;
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '' }, () => now);
    for (let i = 0; i < 3; i++) {
      const d = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
      assert.ok(d.kind === 'draft');
      await runs.prepare(d.run.id);
      assert.equal(runs.prepareThrottled(), false, `${i}`);
      host.emit('run', { runId: d.run.id, type: 'end', status: 'failed', code: 'assert.supplier_mismatch' });
    }
    assert.equal(runs.prepareThrottled(), true);
    now += 60_000;
    assert.equal(runs.prepareThrottled(), false, '60초 뒤에는 다시');
  });
});

describe('audit-d: D5 클릭 활성화 예외 축소(N-48)', () => {
  const at = { x: 300, y: 45 };
  const mk = () => {
    const g = new BarGate(600);
    g.setSize(600, 90);
    return g;
  };
  it('activation not from a handoff rejects the first click and rearms', () => {
    const g = mk();
    g.rearm(0, true);
    assert.equal(g.mouse({ type: 'mouseDown', ...at, button: 'left' }, 700), null, '무장됨에서 눌림');
    g.windowActivated(705); // 포커스가 mouseDown 뒤에 옴(앞으로 가져오기)
    assert.equal(g.mouse({ type: 'mouseUp', ...at, button: 'left' }, 710), null, '앞으로 가져오는 클릭은 승인이 아니다');
    assert.equal(g.armed(1200), false, '무장 지연을 다시 센다');
    assert.deepEqual(g.mouse({ type: 'mouseDown', ...at, button: 'left' }, 750), { kind: 'refused', reason: 'arming' });
  });

  it('activation within 120s of a handoff keeps the 100ms exception', () => {
    const g = mk();
    g.rearm(0, true);
    g.mouse({ type: 'mouseDown', ...at, button: 'left' }, 700);
    g.windowActivated(705, true);
    assert.deepEqual(g.mouse({ type: 'mouseUp', ...at, button: 'left' }, 710), { kind: 'approve' });
  });

  it('handoff mark is consumed once and expires after 120s', () => {
    const h = new HandoffMark();
    assert.equal(h.consume(10), false);
    h.note(1000);
    assert.equal(h.consume(1000 + HANDOFF_RETURN_MS), true);
    assert.equal(h.consume(1000 + HANDOFF_RETURN_MS), false, '한 번만');
    h.note(0);
    assert.equal(h.consume(HANDOFF_RETURN_MS + 1), false, '120초가 지나면 핸드오프 복귀가 아니다');
    // 바: 비밀 창이 닫히면 noteHandoff, 창 blur면 무장 전 페이지.
    assert.match(src('shell-app.ts'), /bar\.noteHandoff\(\)/);
    assert.match(src('approval-bar.ts'), /win\.on\('blur'/);
  });
});

describe('audit-d: D6 중복 경고 상태별 표시(N-22·N-02)', () => {
  it('committed duplicate → attention tone, 이미 발급됨, 한 번 더 발급 action', () => {
    const req = base({ '$dup.businessKey': 'committed' });
    const l = (summarize(req, '2026-11-03') as SummaryLine[])[1]!;
    assert.deepEqual([l.flag, l.tone], ['이미 발급됨(승인번호 있음)', 'attention']);
    assert.equal(actionText(req), ACTION_TEXT_DUP_COMMITTED);
    assert.match(buildBarHtml(summarize(req) as SummaryLine[], 'unarmed'), /<body class="unarmed attn">/);
  });

  it('in_doubt duplicate → 발급 여부 확인 안 됨', () => {
    for (const s of ['in_doubt', 'armed', 'dispatched', 'observed_manual', 'not_committed,in_doubt']) {
      const req = base({ '$dup.businessKey': s, '$dup.priorNotCommitted': 'true' });
      const l = (summarize(req) as SummaryLine[])[1]!;
      assert.deepEqual([l.flag, l.tone], ['발급 여부 확인 안 됨', 'attention'], s);
      assert.equal(actionText(req), ACTION_TEXT_DUP);
    }
  });

  it('only not_committed → 직전 시도 미발급 판정 with normal tone', () => {
    const req = base({ '$dup.businessKey': 'not_committed', '$dup.priorNotCommitted': 'true' });
    const l = (summarize(req) as SummaryLine[])[1]!;
    assert.deepEqual([l.flag, l.tone], ['직전 시도 미발급 판정', 'normal']);
    assert.equal(actionText(req), ACTION_TEXT_DUP);
    assert.doesNotMatch(buildBarHtml(summarize(req) as SummaryLine[], 'armed'), /attn/);
  });
});

describe('audit-d: D7 작성일 조각·가짜 H-01 KST(N-26·I-8)', () => {
  const totalText = (r: ReturnType<typeof summarize>) => (r as SummaryLine[])[1]!.pieces.map((p) => p.text).join('');
  it('issueDate equal to KST today adds nothing to the bar', () => {
    assert.equal(totalText(summarize(base({ issueDate: '2026-11-03' }), '2026-11-03')), '3,630,000원 · 세액 330,000원');
  });
  it('different issueDate appends 작성일 piece (줄이지 않는 조각)', () => {
    const r = summarize(base({ issueDate: '2026-11-02' }), '2026-11-03') as SummaryLine[];
    assert.equal(totalText(r), '3,630,000원 · 세액 330,000원 · 작성일 2026-11-02');
    assert.equal(r[1]!.pieces.at(-1)!.shrink, undefined);
  });
  it('malformed issueDate refuses arming', () => {
    for (const bad of ['2026-11-3', '2026/11/03', '20261103', '2026-11-03 ']) assert.deepEqual(summarize(base({ issueDate: bad }), '2026-11-03'), { reason: 'unsafe', label: '합계' }, bad);
  });
  it('fixture today() is the KST day at 14:30Z (and kstToday agrees)', () => {
    const t = Date.parse('2026-11-02T14:30:00Z');
    assert.equal(fixtureToday(t), '2026-11-02');
    assert.equal(fixtureToday(Date.parse('2026-11-02T15:30:00Z')), '2026-11-03', 'UTC 15시 = KST 자정 넘김');
    assert.equal(kstToday(Date.parse('2026-11-02T15:30:00Z')), '2026-11-03');
  });
});

describe('audit-d: D8 승인 바 내장 팔레트(N-80)', () => {
  const tokens = () => structuredClone({ light: { ...BAR_PALETTE_DEFAULT.light } as Record<string, string>, dark: { ...BAR_PALETTE_DEFAULT.dark } as Record<string, string> });
  it('CSS-escape token value falls back to the built-in palette', () => {
    const t = tokens();
    t.light.accent = '#2A4F9E}body{display:none';
    const r = barPalette(t);
    assert.equal(r.palette, BAR_PALETTE_DEFAULT);
    assert.equal(r.rejected, 'format:light.accent');
    assert.ok(!barCss(r.palette).includes('display:none'));
  });
  it('low-contrast pair falls back', () => {
    const t = tokens();
    t.dark['on-accent'] = t.dark.accent!;
    assert.equal(barPalette(t).rejected, 'contrast:dark.on-accent/accent');
    const u = tokens();
    u.light['attention-soft'] = '#8A5A0C';
    assert.equal(barPalette(u).rejected, 'contrast:light.attention/attention-soft');
    delete (u.light as Record<string, string | undefined>)['attention-soft'];
    assert.equal(barPalette(u).rejected, 'format:light.attention-soft');
  });
  it('current tokens.json passes as-is (and equals the built-in palette)', () => {
    const r = barPalette(loadTokens());
    assert.equal(r.rejected, null);
    assert.deepEqual(r.palette, BAR_PALETTE_DEFAULT);
    const css = barCss(r.palette);
    assert.match(css, /body\.armed\.attn\{background:#8A5A0B;color:#FFFFFF\}/);
    assert.match(css, /body\.unarmed\.attn\{background:#F8EEDC;color:#8A5A0B\}/);
  });
});

describe('audit-d: D9 스모크 임시 루트(N-57)', () => {
  it('smokeRootPlan refuses when the real root has db.sqlite', () => {
    const real = path.join('/r', 'SovereignAX');
    const p = smokeRootPlan({ env: { PATH: '/bin' }, tmp: '/t', realRoot: real, exists: (f) => f === path.join(real, 'db', 'db.sqlite') });
    assert.equal(p.ok, false);
    assert.match(p.reason!, /DB가 있어/);
  });
  it('smokeRootPlan points LOCALAPPDATA and HOME to the temp root', () => {
    const p = smokeRootPlan({ env: { PATH: '/bin', HOME: '/home/u', LOCALAPPDATA: 'C:\\U' }, tmp: '/t', realRoot: '/r', exists: () => false });
    assert.equal(p.ok, true);
    assert.deepEqual([p.env.LOCALAPPDATA, p.env.HOME, p.env.PATH], ['/t', '/t', '/bin']);
    const smoke = fs.readFileSync(path.join(root, 'tests/app-smoke.ts'), 'utf8');
    assert.match(smoke, /smokeRootPlan\(/);
    assert.ok(!/args: \[appDir\] \}\)/.test(smoke), '실 루트 환경으로 띄우는 호출이 없다');
  });
});

describe('audit-d: D10·D11 단일 인스턴스, docparse 대화상자(N-29·N-68)', () => {
  it('shell entry and main.ts call requestSingleInstanceLock before whenReady', () => {
    for (const f of ['shell.ts', 'main.ts']) {
      const s = src(f);
      const lock = s.indexOf('app.requestSingleInstanceLock()');
      assert.ok(lock > 0 && lock < s.indexOf('app.whenReady()'), f);
      assert.match(s, /app\.on\('second-instance'/, f);
    }
  });
  it('docparse BrowserWindow sets disableDialogs:true', () => {
    assert.match(src('docparse.ts'), /new BrowserWindow\(\{[\s\S]*?disableDialogs: true[\s\S]*?\}\);/);
  });
});

describe('audit-d: D12 암호 PDF 재시도 상한(N-31)', () => {
  it('fifth wrong password expires the pick and zeroes bytes', () => {
    const s = new PickStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const id = s.keep(bytes, 0);
    for (let i = 1; i < MAX_TRIES; i++) {
      assert.deepEqual([...s.retry(id, i)], [1, 2, 3]);
      assert.equal(s.wrong(id), true, `${i}번째`);
    }
    assert.equal(s.wrong(id), false, '5번째');
    assert.deepEqual([...bytes], [0, 0, 0]);
    assert.throws(() => s.retry(id, 10), /pick_expired/);
  });
  it('retry does not extend the pick TTL; cancel·eviction zero bytes', () => {
    const s = new PickStore();
    const b = new Uint8Array([9]);
    const id = s.keep(b, 0);
    s.retry(id, PICK_TTL_MS - 1);
    assert.throws(() => s.retry(id, PICK_TTL_MS + 1), /pick_expired/, '첫 선택 기준 5분');
    assert.deepEqual([...b], [0]);
    const x = new Uint8Array([7]);
    const y = new Uint8Array([8]);
    const xid = s.keep(x, 0);
    s.keep(y, 0);
    s.keep(new Uint8Array([6]), 0);
    assert.deepEqual([...x], [0], '가장 오래된 것을 밀어내며 지운다');
    assert.throws(() => s.retry(xid, 1), /pick_expired/);
    s.cancel('nope');
    assert.equal(s.size, 2);
  });
  it('retry hands out a copy: cancelling during a retry does not zero the bytes being parsed', () => {
    const s = new PickStore();
    const id = s.keep(new Uint8Array([4, 5]), 0);
    const reading = s.retry(id, 1);
    s.cancel(id);
    assert.deepEqual([...reading], [4, 5], '읽는 중인 사본은 그대로');
  });
});

describe('audit-d: D13 셸 문구·이벤트 연결', () => {
  it('NOTE has a sentence for every I-6 code (and 쿨다운 문구에 "두 번 연속" 없음)', () => {
    for (const c of ['policy.poc_irreversible_total', 'portal.unexpected_page', 'portal.extra_auth_repeat', 'portal.unobservable', 'vault.leak_suspected', 'assert.issue_date_mismatch', 'step.target_not_found', 'checkpoint.expect_failed', 'policy.irreversible_per_day']) {
      assert.ok(NOTE[c] && /[요다]\.?$/.test(NOTE[c]!), c);
    }
    assert.equal(NOTE['policy.cooldown'], '홈택스 차단·경고 신호가 보여 24시간 동안 홈택스 실행을 쉬어요. 아무것도 발급하지 않았어요.');
    assert.equal(NOTE['policy.irreversible_per_day'], '오늘은 PoC 기간 하루 발급 상한(1건)에 닿았어요. 내일 다시 할 수 있어요.');
    assert.equal(NOTE['step.target_not_found'], '예상한 홈택스 화면이 아니에요. 전용 Chrome 창에 뜬 안내를 확인해 주세요. 아무것도 발급하지 않았어요.');
  });

  it('portalNotice is carried as plain text in the run view', async () => {
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '' });
    const d = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(d.kind === 'draft');
    await runs.prepare(d.run.id);
    host.emit('run', { runId: d.run.id, type: 'end', status: 'failed', code: 'portal.unexpected_page', portalNotice: '<b>세션이\u2028만료</b>되었습니다' + 'x'.repeat(300) });
    const r = runs.get(d.run.id)!;
    assert.match(r.stoppedNote!, /예상하지 못한 화면으로/);
    assert.equal(r.notices!.length, 1);
    assert.ok(r.notices![0]!.startsWith('홈택스 안내: “<b>세션이 만료</b>되었습니다'), r.notices![0]);
    assert.ok(r.notices![0]!.length <= '홈택스 안내: “”'.length + 200);
    // 렌더러는 notices를 텍스트 노드(note)로만 넣는다.
    assert.match(fs.readFileSync(path.join(root, 'apps/desktop/static/shell/shell-views.js'), 'utf8'), /for \(const t of run\.notices \|\| \[\]\) card\.append\(note\(t, true\)\);/);
  });

  it('금고 이벤트·fatal 문장: Google 로그인, 설정 바뀜, 누출 의심, 만료, 키 유실, env 변조', async () => {
    assert.match(vaultNotice('secret_window.refused', { reason: 'google_signin_detected' })!.text, /Google 계정이 로그인돼 있어/);
    assert.match(vaultNotice('secret_window.refused', { reason: 'extension_not_allowed' })!.text, /전용 Chrome 설정이 바뀌어/);
    assert.equal(vaultNotice('secret_window.leak_suspected', { hits: 2 })!.text, NOTE['vault.leak_suspected']);
    assert.deepEqual(vaultNotice('secret.expired', { runId: 'run-a', kind: 'cert_password' }), { runId: 'run-a', text: '입력한 비밀번호를 5분 안에 쓰지 않아 지웠어요. 필요할 때 다시 물어볼게요.' });
    assert.equal(vaultNotice('secret.needed', {}), null);
    assert.match(fatalText('vault: db.key_missing')!, /앱 열쇠를 찾지 못했어요/);
    assert.match(fatalText('vault: vault.keystore_mismatch')!, /앱 열쇠를 찾지 못했어요/);
    assert.equal(fatalText('engine.env_tampered:NODE_OPTIONS'), '개발용 환경 변수가 켜져 있어 앱을 열지 않았어요.');
    assert.equal(fatalText('engine_exit'), null);
    // 금고 알림은 진행 중인 실행 카드에 붙는다.
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '' });
    const d = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(d.kind === 'draft');
    await runs.prepare(d.run.id);
    runs.notice(undefined, 'x');
    runs.notice(undefined, 'x');
    assert.deepEqual(runs.get(d.run.id)!.notices, ['x']);
    assert.equal(runs.isActive(d.run.id), true);
    // 끝났거나 모르는 실행의 알림도 진행 중인 실행 카드에 붙는다(끝난 카드에 묻히지 않게).
    runs.notice('run-gone', 'y');
    assert.deepEqual(runs.get(d.run.id)!.notices, ['x', 'y']);
  });
});
