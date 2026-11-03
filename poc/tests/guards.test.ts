// 정적 경계: engine의 송신 직접 import 금지(D01 §3), --remote-debugging-port 금지(D05 §3), Chrome 인자 허용 목록, 승인 바 판정(ADR-021).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { buildChromeArgs, chromeEnv } from '@sax/vault';
import { buildGateRequest, gateSelfCheck, type GateField } from '@sax/engine/gate';
import { ACTION_TEXT, ACTION_TEXT_DUP, ACTION_TEXT_DUP_COMMITTED, actionText, BarGate, buildBarHtml, issueLocalApproval, KEYBOARD_APPROVAL, overflowLine, summarize, verifyLocalApproval, type SummaryLine } from '../apps/desktop/src/approval-gate.ts';
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

  it('eslint: 금고에서 fetch·electron net·계산된 동적 import는 오류(ADR-025 결정 6)', async () => {
    const eslint = new ESLint({ cwd: root });
    const [r] = await eslint.lintText(
      `import { net } from 'electron';\nexport const f = (m: string) => [fetch('https://x'), net, import(m), import('node:http')];\n`,
      { filePath: path.join(root, 'packages/vault/src/_probe.ts') },
    );
    const ids = r!.messages.map((m) => m.ruleId);
    assert.ok(ids.includes('no-restricted-imports'), 'electron net');
    assert.ok(ids.includes('no-restricted-globals'), 'fetch');
    assert.equal(ids.filter((i) => i === 'no-restricted-syntax').length, 2, '계산된 import·송신 모듈 import');
    // 리터럴 이름의 지연 로드(키체인 모듈)는 통과한다.
    const [ok] = await eslint.lintText(`export const k = () => import('@napi-rs/keyring');\n`, { filePath: path.join(root, 'packages/vault/src/_probe.ts') });
    assert.deepEqual(ok!.messages, []);
  });

  it("eslint: 엔진에서 child_process·createRequire('node:net')는 오류, ajv createRequire 로드는 허용", async () => {
    const eslint = new ESLint({ cwd: root });
    const [r] = await eslint.lintText(
      `import { spawn } from 'node:child_process';\nimport { createRequire } from 'node:module';\nexport const n = [spawn, createRequire(import.meta.url)('node:net')];\n`,
      { filePath: path.join(root, 'packages/engine/src/_probe.ts') },
    );
    const ids = r!.messages.map((m) => m.ruleId);
    assert.ok(ids.includes('no-restricted-imports'), 'child_process');
    assert.ok(ids.includes('no-restricted-syntax'), "createRequire(...)('node:net')");
    const [ok] = await eslint.lintText(`import { createRequire } from 'node:module';\nexport const Ajv = createRequire(import.meta.url)('ajv');\n`, { filePath: path.join(root, 'packages/engine/src/_probe.ts') });
    assert.deepEqual(ok!.messages, []);
    // 데스크톱 main도 송신 규칙 범위다(e2e·가짜 페이지 서버는 명시 면제).
    const [d] = await eslint.lintText(`import http from 'node:http';\nexport const h = http;\n`, { filePath: path.join(root, 'apps/desktop/src/_probe.ts') });
    assert.ok(d!.messages.some((m) => m.ruleId === 'no-restricted-imports'));
    const [fx] = await eslint.lintText(`import http from 'node:http';\nexport const h = http;\n`, { filePath: path.join(root, 'apps/desktop/src/h01-fixture.ts') });
    assert.deepEqual(fx!.messages, []);
  });

  it('Chrome 인자: 허용 목록(고정 인자) + 금지 인자 거부, 환경 변수 화이트리스트', () => {
    // 고정 인자 3개. 금고 패키지(V1)가 --disable-breakpad를 더하면 그것만 붙는다.
    const args = buildChromeArgs('/p');
    assert.deepEqual(args.slice(0, 3), ['--remote-debugging-pipe', '--user-data-dir=/p', '--no-first-run']);
    assert.ok(args.slice(3).every((a) => a === '--disable-breakpad'), JSON.stringify(args));
    for (const bad of ['--remote-debugging-port=0', '--remote-allow-origins=*', '--no-sandbox', '--disable-extensions']) assert.throws(() => buildChromeArgs('/p', [bad]));
    const env = chromeEnv({ HOME: '/h', PATH: '/bin', HTTPS_PROXY: 'http://evil', CHROME_LOG_FILE: '/tmp/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  });

  it('승인 바 판정: 무장 지연·재시작, 머무름, 바 안 down→up만, 클릭 활성화 예외, 커서 위장, 키보드 없음', () => {
    const g = new BarGate(600);
    g.setSize(600, 90);
    const at = { x: 300, y: 45 };
    const move = (t: number, dx = 3) => g.mouse({ type: 'mouseMove', ...at, movementX: dx, movementY: 0 }, t);
    const down = (t: number, p = at) => g.mouse({ type: 'mouseDown', ...p, button: 'left' }, t);
    const up = (t: number, p = at) => g.mouse({ type: 'mouseUp', ...p, button: 'left' }, t);
    g.rearm(1000, false);
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
    // 앞 게이트에서 바 안에 있던 추적 상태가 다음 게이트로 넘어가지 않는다: main이 OS 커서로 정한 값(밖)을 쓴다.
    g.rearm(5000, false);
    move(5700);
    assert.deepEqual(down(5720), { kind: 'refused', reason: 'dwell' }, '다음 게이트에서 입력창에서 튀어 올라온 클릭은 거부');
    // 멈춘 커서 아래에 바가 뜬 경우(main이 안이라고 계산): 움직이지 않아도 600ms 뒤에는 된다.
    g.rearm(6000, true);
    down(6700);
    assert.deepEqual(up(6710), { kind: 'approve' });
    // 멈춘 커서 예외는 OS 커서가 무장 사건 때 자리 그대로일 때만: 바를 덮은 알림 위에서 움직였다가(바는 나감을 못 받음)
    // 알림이 사라지자마자 누른 클릭은 머무름으로 거부한다.
    g.rearm(6800, true);
    move(7400);
    assert.deepEqual(g.mouse({ type: 'mouseDown', ...at, button: 'left' }, 7410, false), { kind: 'refused', reason: 'dwell' });
    // 바 밖으로 나가는 mouseMove는 나감으로 친다.
    g.rearm(7000, true);
    g.mouse({ type: 'mouseMove', x: 300, y: 200, movementX: 0, movementY: 9 }, 7100);
    assert.deepEqual(down(7700), { kind: 'refused', reason: 'dwell' });
    // 핸드오프 복귀 활성화: 100ms 안 바 클릭은 재무장 없이 판정, 아니면 재무장. 타이머가 늦어도 늦은 클릭은 재무장·거부.
    g.rearm(8000, true);
    g.windowActivated(8700, true);
    down(8750);
    assert.equal(g.activationSettled(), false);
    assert.deepEqual(up(8760), { kind: 'approve' });
    g.windowActivated(9000, true);
    assert.equal(g.activationSettled(), true);
    g.windowActivated(10_000, true);
    assert.deepEqual(down(10_300), { kind: 'refused', reason: 'arming' }, '활성화 뒤 100ms가 지난 첫 클릭은 재무장');
    assert.equal(g.armed(10_800), false);
    // 포커스가 mouseDown 뒤에 오면(OS 순서) 클릭 활성화로 보고 그 클릭을 버리지 않는다(핸드오프 복귀일 때만).
    g.rearm(11_000, true);
    down(11_700);
    g.windowActivated(11_710, true);
    assert.equal(g.activationSettled(), false);
    assert.deepEqual(up(11_720), { kind: 'approve' });
    // 커서 위장 중에는 무장하지 않고 이유를 알린다.
    g.rearm(12_000, true);
    g.setCursorBlocked(true);
    assert.equal(g.armed(13_000), false);
    assert.deepEqual(down(13_000), { kind: 'refused', reason: 'cursor' });
    g.setCursorBlocked(false);
    // 키보드 승인 없음(Alt+Y 경로는 꺼 둠).
    assert.equal(KEYBOARD_APPROVAL, false);
    assert.equal(g.key({ type: 'keyDown', key: 'y', alt: true }, 20_000), null);
    assert.equal(g.key({ type: 'keyDown', key: 'Enter' }, 20_000), null);
  });

  it('승인 바 내용: 요약 줄은 fields에서만, 값 이스케이프, 위험 문자·빈 값·중복 키 거부, 넘치면 띠로, CSP', () => {
    const base = (over: Record<string, string> = {}, extra: Array<{ fieldKey: string; value: string }> = []) => {
      const v: Record<string, string> = { counterpartName: 'A상사', counterpartBizNo: '2148651233', counterpartEmail: 'tax@bücher.example', totalAmount: '3630000', taxAmount: '330000', '$first.bizNo': 'true', ...over };
      return { fields: [...Object.entries(v).map(([fieldKey, value]) => ({ fieldKey, value })), ...extra] as GateField[] };
    };
    const lines = summarize(base()) as SummaryLine[];
    assert.ok(Array.isArray(lines));
    assert.deepEqual(lines.map((l) => l.label), ['공급받는자', '합계', '받는 이메일']);
    assert.equal(lines[0]!.flag, '처음 거래');
    assert.equal(lines[1]!.pieces.map((p) => p.text).join(''), '3,630,000원 · 세액 330,000원');
    assert.equal(lines[2]!.pieces[1]!.text, '@xn--bcher-kva.example', '국제화 도메인은 punycode');
    const big = summarize(base({ totalAmount: '12345678901234567'.slice(0, 15), taxAmount: '0' })) as SummaryLine[];
    assert.equal(big[1]!.pieces[0]!.text, '123,456,789,012,345원', '해시한 문자열 그대로 자릿수를 묶는다');
    for (const bad of ['A상사‮', 'Aㅤ상사', 'ᅟ', 'A͏']) assert.deepEqual(summarize(base({ counterpartName: bad })), { reason: 'unsafe', label: '공급받는자' }, JSON.stringify(bad));
    assert.deepEqual(summarize(base({ counterpartBizNo: '214865123' })), { reason: 'unsafe', label: '공급받는자' }, '사업자번호는 10자리');
    assert.equal((summarize(base({ counterpartEmail: '' })) as SummaryLine[])[2]!.pieces.map((p) => p.text).join(''), '없음 · 메일을 보내지 않아요', '받는 이메일이 없으면 메일을 보내지 않는다고 보인다');
    assert.deepEqual(summarize(base({ counterpartEmail: 'a‮@x.example' })), { reason: 'unsafe', label: '받는 이메일' });
    assert.deepEqual(summarize(base({}, [{ fieldKey: 'counterpartName', value: 'B상사' }])), { reason: 'duplicate' });
    assert.equal(overflowLine(lines, 600), null);
    assert.equal(overflowLine(lines, 420), '공급받는자');
    // 긴 이메일 도메인·처음 보내는 주소·10억 이상도 띠(창 폭)로 넓히면 들어간다. "창을 넓혀 주세요"는 띠로도 넘칠 때만.
    const long = summarize(base({ counterpartEmail: 'a@회사이름이긴곳.한국', '$first.email': 'true', totalAmount: '1100000000', taxAmount: '100000000' })) as SummaryLine[];
    assert.equal(overflowLine(long, barBounds(1280, 820).width), '받는 이메일');
    assert.equal(overflowLine(long, barBounds(1280, 820, true).width), null);
    const html = buildBarHtml(summarize(base({ counterpartName: '<script>alert(1)</script>' })) as SummaryLine[], 'armed');
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(html, /default-src 'none'; style-src 'self'/);
    assert.ok(!/<button|<a |<input|onclick/i.test(html), '바 안에 작은 버튼·링크가 없다');
    // 중복 경고($dup.*)는 합계 줄 표시와 동작 글자로 바에 보인다(ADR-021). 이 클릭이 D02 §7 명시 확인이다.
    // 원장 상태별로 다르게(ADR-024 결정 3): 발급 확정은 "이미 발급됨"·주의 색·"한 번 더 발급".
    const dup = base({ '$dup.businessKey': 'committed' });
    assert.equal((summarize(dup) as SummaryLine[])[1]!.flag, '이미 발급됨(승인번호 있음)');
    assert.equal(actionText(dup), ACTION_TEXT_DUP_COMMITTED);
    assert.equal(actionText(base({ '$dup.businessKey': 'in_doubt' })), ACTION_TEXT_DUP);
    assert.equal(actionText(base()), ACTION_TEXT);
    const prior = base({ '$dup.businessKey': 'not_committed', '$dup.priorNotCommitted': 'true' });
    assert.equal((summarize(prior) as SummaryLine[])[1]!.flag, '직전 시도 미발급 판정');
    // 발급된(또는 모르는) 같은 건이 있으면 "직전 시도 미발급"보다 먼저 보인다(그 경고가 발급된 건을 가리면 중복 발급).
    for (const [states, flag] of [['committed,not_committed', '이미 발급됨(승인번호 있음)'], ['in_doubt,not_committed', '발급 여부 확인 안 됨'], ['dispatched,not_committed', '발급 여부 확인 안 됨']]) {
      assert.equal((summarize(base({ '$dup.businessKey': states!, '$dup.priorNotCommitted': 'true' })) as SummaryLine[])[1]!.flag, flag, states);
    }
    assert.match(buildBarHtml(summarize(dup) as SummaryLine[], 'armed', undefined, actionText(dup)), /<body class="armed attn">.*그래도 한 번 더 발급/s);
  });

  it('게이트 요청 v2: main이 fields로 해시를 다시 계산한다. 예약 키를 빼거나 값을 바꾸면 맞지 않는다. LocalApproval v2', () => {
    const readback = {
      supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '2148651233', counterpartName: 'A상사', counterpartEmail: 'tax@asangsa.example',
      itemName: '경영 컨설팅', itemCount: '1', supplyAmount: '3300000', taxAmount: '330000', totalAmount: '3630000', issueDate: '2026-11-01', remark: '', receiptType: '영수',
    };
    const req = buildGateRequest({ runId: 'r1', gateStepId: 's20', readback, reserved: [{ fieldKey: '$first.bizNo', value: 'true' }, { fieldKey: '$first.email', value: 'true' }, { fieldKey: '$dup.businessKey', value: 'committed' }], packageDigest: 'a'.repeat(64), authorizes: ['s21'], intentId: 'i1', waitMs: 1000 });
    assert.equal(gateSelfCheck(req), null);
    const noFirst = buildGateRequest({ runId: 'r1', gateStepId: 's20', readback, reserved: [{ fieldKey: '$first.bizNo', value: 'true' }], packageDigest: 'a'.repeat(64), authorizes: ['s21'], intentId: 'i1', waitMs: 1000 });
    assert.equal(gateSelfCheck(noFirst), 'field_key', '해시가 맞아도 $first.* 둘 중 하나가 없으면 엔진 버그');
    assert.equal(gateSelfCheck({ ...req, fields: req.fields.filter((f) => !f.fieldKey.startsWith('$dup.')) }), 'action_hash', '중복 경고를 빼면 cardHash가 맞지 않는다');
    assert.equal(gateSelfCheck({ ...req, fields: req.fields.map((f) => (f.fieldKey === 'totalAmount' ? { ...f, value: '363000' } : f)) }), 'readback_hash');
    assert.equal(gateSelfCheck({ ...req, fields: [...req.fields, { fieldKey: '$first.bizNo', value: 'false' }] }), 'duplicate');
    assert.equal(gateSelfCheck({ ...req, fields: [...req.fields, { fieldKey: 'memo' as never, value: 'x' }] }), 'field_key');
    const key = new Uint8Array(32).fill(7);
    const now = 1_000_000;
    const ap = issueLocalApproval(key, req, 'click', 120_000, now);
    assert.deepEqual([ap.v, ap.runId, ap.gateStepId, ap.reqId, ap.approvalNonce, ap.actionHash, ap.exp, ap.presence], [2, 'r1', 's20', req.reqId, req.approvalNonce, req.actionHash, now + 120_000, 'click']);
    assert.equal(verifyLocalApproval(key, ap, now + 1), true);
    assert.equal(verifyLocalApproval(key, ap, now + 120_001), false, '만료');
    assert.equal(verifyLocalApproval(key, { ...ap, approvalNonce: 'x' }, now), false, 'nonce도 MAC에 들어간다');
    assert.equal(verifyLocalApproval(key, { ...ap, presence: 'click+waiver' }, now), false, 'presence도 MAC에 들어간다');
    assert.equal(verifyLocalApproval(new Uint8Array(32), ap, now), false);
  });

  it('승인 바 배치: 창 크기만으로 대화 열 하단·입력창 위, 좁으면 레일 오른쪽부터 창 끝까지 띠', () => {
    const b = barBounds(1280, 820);
    assert.deepEqual(b, { x: SHELL.rail + Math.floor((1280 - SHELL.rail - SHELL.panel - 600) / 2), y: 820 - SHELL.composerReserve - SHELL.gap - SHELL.barHeight, width: 600, height: SHELL.barHeight, band: false });
    const n = barBounds(900, 700);
    assert.equal(n.band, true);
    assert.equal(n.x, SHELL.rail);
    assert.equal(n.width, 900 - SHELL.rail);
  });

  it('앱 화면에 커스텀·숨김 커서가 없다(커서 위장 감시가 정상 화면에서 무장을 막지 않게, ADR-021)', () => {
    const dir = path.join(root, 'apps/desktop/static');
    const files = fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(css|html|js)$/.test(f))
      .map((f) => path.join(dir, f));
    files.push(path.join(root, '../sovereign-ax/design-system/components/bundle.css')); // 셸 렌더러가 받는 디자인 시스템 CSS
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(t, /cursor\s*:\s*[^;}"']*(url\(|image-set\(|none)/i, f);
      assert.doesNotMatch(t, /\.style\.cursor|setProperty\(\s*['"]cursor/, f);
    }
  });
});
