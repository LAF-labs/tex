import './os-guard.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { buildGateRequest, type GateRequest } from '@sax/engine/gate';
import { irreversibleText, kstToday } from '../dist/approval-gate.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { HANDOFF_LOGIN, NOTE, SIGN_BY_AUTH, STOP_AFTER_SIGN_NOTE } from '../dist/shell-runs.js';
import { DEMO_DEV } from '../dist/demo-dev.js';
import { SIGN_LABEL } from '../dist/shell-model.js';

registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), `sax-shell-handoff-e2e-${process.pid}`));
app.on('window-all-closed', () => {});

const OUT = process.env.SAX_E2E_OUT ?? path.join(os.tmpdir(), `sax-shell-handoff-e2e-out-${process.pid}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

let S: Shell;
let chrome = false;
const focusCalls: unknown[] = [];
const headful = process.env.SAX_E2E_HEADFUL === '1' && process.platform === 'darwin';
const frontApp = () => execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front']).toString().trim()]).toString();
const js = <T = unknown>(code: string): Promise<T> => S.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
const runStatus = (id: string) => S.runs.get(id)?.status;
const click = (sel: string) => js<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const gesture = () => S.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
async function userClick(sel: string): Promise<boolean> {
  gesture();
  await sleep(30);
  return click(sel);
}
async function shot(name: string): Promise<void> {
  await sleep(120);
  await fs.writeFile(path.join(OUT, `${name}.png`), (await S.win.webContents.capturePage()).toPNG());
}
const lastRunId = () => js<string | null>(`[...document.querySelectorAll('[data-run]')].pop()?.dataset.run ?? null`);
async function toDraft(text: string): Promise<string> {
  const before = await lastRunId();
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
  await click('.sx-send');
  await until('draft', async () => !!(await lastRunId()) && (await lastRunId()) !== before);
  return (await lastRunId())!;
}
async function prepare(id: string): Promise<void> {
  for (let i = 0; i < 3 && runStatus(id) === 'draft'; i++) {
    await userClick(`[data-run="${id}"] [data-act=prepare]`);
    await until('prepare answered', () => runStatus(id) !== 'draft', 3000);
  }
}
const card = (id: string) =>
  js<{ handoff: string | null; text: string; acts: Array<{ act: string; label: string; primary: boolean }>; signWait: boolean; chip: string }>(`(() => {
    const c = document.querySelector('[data-run="${id}"]');
    if (!c) return { handoff: null, text: '', acts: [], signWait: false, chip: '' };
    return {
      handoff: c.dataset.handoff ?? null,
      text: c.innerText,
      acts: [...c.querySelectorAll('[data-act]')].map((b) => ({ act: b.dataset.act, label: b.textContent.trim(), primary: b.classList.contains('sx-btn-primary') })),
      signWait: !!c.querySelector('[data-sign-wait]'),
      chip: c.querySelector('.sx-chip')?.textContent ?? '',
    };
  })()`);

const barWc = () => S.bar.view.webContents;
function barApprove(): void {
  const t = S.bar.snapshot().targets.approve;
  const p = { x: Math.floor(t.x + t.width / 2), y: Math.floor(t.y + t.height / 2) };
  barWc().sendInputEvent({ type: 'mouseEnter', x: p.x, y: p.y });
  barWc().sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, movementX: 3, movementY: 1 });
  barWc().sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  barWc().sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

type Plan = { login: boolean; signStop?: boolean; capOnLogin?: boolean };
const plans: Plan[] = [];
const state = new Map<string, { plan: Plan; at: 'login' | 'gate' | 'sign' | 'verify' | 'end' }>();
const calls: Array<[string, string]> = [];
const ev = (runId: string, e: Record<string, unknown>) => S.host.emit('run', { runId, ...e });
const phases = (runId: string, list: string[]) => {
  for (const p of list) {
    ev(runId, { type: 'phase', phase: p, state: 'now' });
    ev(runId, { type: 'phase', phase: p, state: 'done' });
  }
};
function toGate(runId: string): void {
  const r = S.runs.get(runId)!;
  phases(runId, ['form', 'input', 'readback']);
  ev(runId, { type: 'phase', phase: 'gate', state: 'now' });
  const readback = {
    supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: r.counterparty.bizNo.replace(/\D/g, ''), counterpartName: r.counterparty.name, counterpartEmail: r.email.value,
    itemName: r.item, itemCount: '1', supplyAmount: String(r.supply), taxAmount: String(r.tax), totalAmount: String(r.total), issueDate: kstToday(Date.now()), remark: '', receiptType: '영수',
  };
  const req: GateRequest = buildGateRequest({ runId, gateStepId: 's20', readback, reserved: [{ fieldKey: '$first.bizNo', value: 'false' }, { fieldKey: '$first.email', value: 'false' }], packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: `i-${runId}`, waitMs: 120_000 });
  state.get(runId)!.at = 'gate';
  S.host.emit('gate', req);
}
function toSign(runId: string): void {
  S.host.emit('gate-closed', { runId, reqId: 'x', reason: 'answered' });
  ev(runId, { type: 'phase', phase: 'gate', state: 'done' });
  ev(runId, { type: 'phase', phase: 'sign', state: 'now' });
  setTimeout(() => {
    state.get(runId)!.at = 'sign';
    ev(runId, { type: 'handoff', phase: 'sign', code: 'sign.waiting' });
  }, 200);
}
function engineFinishesSign(runId: string): void {
  state.get(runId)!.at = 'end';
  ev(runId, { type: 'phase', phase: 'sign', state: 'done' });
  phases(runId, ['verify', 'mail']);
  ev(runId, { type: 'end', status: 'success', approvalNo: '20261112-41000000-0000e2e1', mailConfirmed: true });
}

function scriptHost(): void {
  const realRpc = S.host.rpc.bind(S.host);
  S.host.rpc = (async (method: string, params: Record<string, unknown> = {}) => {
    const runId = String(params.runId ?? '');
    if (!/^run\.(start|resume|manualDone|stop)$/.test(method)) return realRpc(method, params);
    calls.push([method, runId]);
    if (method === 'run.start') {
      const plan = plans.shift()!;
      state.set(runId, { plan, at: 'login' });
      setTimeout(() => {
        ev(runId, { type: 'phase', phase: 'login', state: 'now' });
        if (!plan.login) {
          ev(runId, { type: 'phase', phase: 'login', state: 'done' });
          return toGate(runId);
        }
        ev(runId, { type: 'handoff', phase: 'login', code: 'step.timeout' });
        if (plan.capOnLogin) setTimeout(() => ev(runId, { type: 'end', status: 'handoff', code: 'run.handoff_timeout' }), 1500);
      }, 100);
      return {};
    }
    const s = state.get(runId);
    if (!s) return { ok: false, code: 'no_run' };
    if (method === 'run.resume') {
      if (s.at === 'login') {
        setTimeout(() => {
          ev(runId, { type: 'phase', phase: 'login', state: 'done' });
          toGate(runId);
        }, 300);
        return { ok: true };
      }
      if (s.at === 'sign') {
        setTimeout(() => engineFinishesSign(runId), 300);
        return { ok: true };
      }
      return { ok: false, code: 'not_paused' };
    }
    if (method === 'run.manualDone') return s.at === 'sign' ? { ok: false, code: 'sign.turn_resume_only' } : { ok: true };
    if (s.at === 'sign') {
      s.at = 'verify';
      setTimeout(() => {
        ev(runId, { type: 'phase', phase: 'verify', state: 'now' });
        setTimeout(() => {
          s.at = 'end';
          ev(runId, { type: 'end', status: 'in_doubt', code: 'in_doubt' });
        }, 1500);
      }, 200);
      return { stopped: false };
    }
    s.at = 'end';
    setTimeout(() => ev(runId, { type: 'end', status: 'stopped', code: 'run.stopped' }), 50);
    return { stopped: true };
  }) as typeof S.host.rpc;
  const realAnswer = S.host.answerGate.bind(S.host);
  S.host.answerGate = (async (a: { runId: string }) => {
    if (!state.has(a.runId)) return realAnswer(a as never);
    toSign(a.runId);
    return { ok: true };
  }) as typeof S.host.answerGate;
}

async function approveGate(id: string): Promise<boolean> {
  if (!(await until('waiting', () => runStatus(id) === 'waiting', 10_000))) return false;
  if (!(await until('bar armed', () => S.bar.snapshot().visible && S.bar.snapshot().armed && S.bar.snapshot().committed?.mode === 'armed', 10_000))) console.log('  bar:', JSON.stringify(S.bar.snapshot()).slice(0, 600));
  barApprove();
  return until('approved', () => S.runs.get(id)?.approvedPending === true || runStatus(id) !== 'waiting', 5000);
}

const onbStep = () => js<string | null>(`[...document.querySelectorAll('[data-onb-step]')].pop()?.dataset.onbStep ?? null`);
async function pressOnb(sel: string): Promise<void> {
  gesture();
  await sleep(30);
  const ok = await js<boolean>(`(() => { const sec = [...document.querySelectorAll('section.onb')].pop(); const b = sec && [...sec.querySelectorAll(${JSON.stringify(sel)})].pop(); if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no onb button ${sel}`);
}
async function onbReply(sel: string, next: string): Promise<boolean> {
  await pressOnb(sel);
  return until(`onb ${next}`, async () => (await onbStep()) === next, 10_000);
}
async function finishOnboarding(): Promise<boolean> {
  await until('terms', async () => (await onbStep()) === 'terms', 15_000);
  const ok =
    (await onbReply('[data-onb=agree]', 'welcome')) &&
    (await onbReply('[data-onb=upload]', 'biz-confirm')) &&
    (await onbReply('[data-onb=confirm]', 'auth')) &&
    (await onbReply('[data-onb=simple]', 'model')) &&
    (await onbReply('[data-onb=agree]', 'telemetry')) &&
    (await onbReply('[data-onb=off]', 'tasks'));
  if (!ok) return false;
  if (!(await js<boolean>(`document.querySelector('[data-task=H-01]')?.getAttribute('aria-pressed') === 'true'`))) await pressOnb('[data-task=H-01]');
  if (!((await onbReply('[data-onb=submit]', 'counterparties')) && (await onbReply('[data-onb=later]', 'summary')) && (await onbReply('[data-onb=ok]', 'first')))) return false;
  await pressOnb('[data-onb=later]');
  return until('onboarding done', async () => !(await js<boolean>(`!!document.querySelector('[data-onb-step]:not([data-onb-step=done])')`)), 8000);
}
async function changeAuthInSettings(kind: 'cert' | 'simple'): Promise<{ note: boolean; atAuth: boolean; atSummary: boolean; ended: boolean }> {
  await userClick('#rail [data-view=settings]');
  await until('settings', () => js<boolean>(`!!document.querySelector('[data-act=auth-reopen]')`), 5000);
  const note = await js<boolean>(`(document.querySelector('[data-auth-note]')?.textContent ?? '').includes('진행 중인 작업은 원래 인증으로 끝내요')`);
  await shot(`06-settings-auth-before-${kind}`);
  await userClick('[data-act=auth-reopen]');
  const atAuth = await until('reopen auth', async () => (await onbStep()) === 'auth', 8000);
  if (!atAuth) return { note, atAuth, atSummary: false, ended: false };
  if (kind === 'cert') {
    await pressOnb('[data-onb=cert]');
    await until('certs', () => js<boolean>(`!![...document.querySelectorAll('section.onb')].pop()?.querySelector('[data-onb=cert-pick]:not([disabled])')`), 5000);
    await pressOnb('[data-onb=cert-pick]');
  } else await pressOnb(`[data-onb=${kind}]`);
  const atSummary = await until('summary', async () => (await onbStep()) === 'summary', 8000);
  await pressOnb('[data-onb=ok]');
  const ended = await until('reopen ended', async () => (await onbStep()) !== 'summary', 8000);
  return { note, atAuth, atSummary, ended };
}

async function flow(): Promise<void> {
  await S.ready;
  scriptHost();
  await S.host.rpc('browser.open', {});
  const realControl = S.host.control.bind(S.host);
  S.host.control = (async (m: string, p: Record<string, unknown> = {}) => {
    const r = await realControl(m, p);
    if (m === 'browser.focus' || (m === 'browser.place' && p.front === true)) focusCalls.push(r);
    return r;
  }) as typeof S.host.control;
  await until('composer', () => js<boolean>(`!!document.querySelector('#composer')`), 15_000);
  check('온보딩을 사업자 간편인증으로 끝낸다', (await finishOnboarding()) && (await S.host.rpc('db.query.profiles.list').then((ps) => (ps as Array<{ kind: string; signMethod: string | null }>).some((x) => x.kind === 'business' && x.signMethod === 'simple_auth'))));
  if (process.env.SAX_E2E_DEBUG) console.log(await js(`document.body.innerText.slice(0, 600)`));

  const setupRow = () => js<string>(`(() => { document.querySelector('[data-act=board-toggle][aria-expanded=false]')?.click(); return [...document.querySelectorAll('[data-board-setup] [data-setup]')].map((b) => b.dataset.setup + ':' + b.innerText).join('|'); })()`);
  check('(U6) Chrome이 없으면 첫 판의 할 일에 [Chrome 설치하기]', await until('board chrome', async () => (await setupRow()).includes('chrome:Chrome 설치하기'), 10_000), await setupRow());
  const setupCount = () => js<number>(`document.querySelectorAll('[data-setup-needed]').length`);
  const setupsBefore = await setupCount();
  await js(`(() => { const t = document.querySelector('#composer'); t.value = '사업자등록증명 떼 줘'; t.dispatchEvent(new Event('input')); })()`);
  await click('.sx-send');
  const lastSetup = () => js<string>(`(() => { const b = [...document.querySelectorAll('[data-setup-needed]')].pop(); return b ? b.dataset.setupNeeded + '|' + b.innerText : ''; })()`);
  const certAsked = await until('cert setup', async () => (await setupCount()) > setupsBefore && (await lastSetup()).includes('증명서를 떼려면'), 5000);
  check('(U6) Chrome이 없으면 증명서 요청에도 설치 안내와 [Chrome 설치하기](실행 없음)', certAsked && (await lastSetup()).startsWith('chrome') && !calls.some(([m]) => m === 'run.startCert'), { reply: await lastSetup() });
  await shot('00-cert-no-chrome-ask');
  const setupsAfterCert = await setupCount();
  const runsBefore = S.runs.list().length;
  await js(`(() => { const t = document.querySelector('#composer'); t.value = 'A상사에 11만원 세금계산서'; t.dispatchEvent(new Event('input')); })()`);
  await click('.sx-send');
  const setupReply = () => js<string>(`(() => { const b = [...document.querySelectorAll('[data-setup-needed]')].pop(); return b ? b.dataset.setupNeeded + '|' + b.innerText : ''; })()`);
  check(
    '(U6) Chrome이 없으면 첫 발급 요청에 초안 카드 대신 설치 안내와 [Chrome 설치하기](실행 없음)',
    (await until('setup chrome', async () => (await setupCount()) > setupsAfterCert && (await setupReply()).startsWith('chrome|'), 5000)) && (await setupReply()).includes('Chrome을 설치해 주세요') && S.runs.list().length === runsBefore && !calls.some(([m]) => m === 'run.start'),
    { reply: await setupReply(), runs: S.runs.list().length },
  );
  await userClick('[data-setup-needed] [data-act=setup-chrome]');
  const guide = () => js<string>(`document.querySelector('[data-chrome-guide]')?.innerText ?? ''`);
  check('(U6) [Chrome 설치하기] → 설치 안내(주소는 글자로만, 외부 링크 없음)', (await until('guide', async () => (await guide()).includes('google.com/chrome'), 3000)) && !(await js<boolean>(`!!document.querySelector('[data-chrome-guide] a')`)), await guide());
  await shot('00a-chrome-guide');
  await userClick('[data-chrome-guide] [data-act=chrome-check]');
  await sleep(400);
  check('(U6) 아직 없으면 [다시 확인] 뒤에도 안내가 남고 할 일도 남는다', (await guide()) !== '' && (await setupRow()).includes('chrome:'), { guide: await guide(), row: await setupRow() });
  chrome = true;
  await userClick('[data-chrome-guide] [data-act=chrome-check]');
  check('(U6) 설치한 뒤 [다시 확인] → 안내가 닫히고 판의 할 일에서 빠진다', (await until('guide gone', async () => (await guide()) === '', 3000)) && (await until('row gone', async () => !(await setupRow()).includes('chrome:'), 5000)), { guide: await guide(), row: await setupRow() });
  await shot('00b-chrome-found');

  const z = await toDraft('A상사에 11만원 세금계산서');
  chrome = false;
  await userClick(`[data-run="${z}"] [data-act=prepare]`);
  check('Chrome이 없으면 준비하지 않고 초안 카드에 설치 안내(엔진 run.start 없음)', await until('no chrome', async () => js<boolean>(`(() => { const c = document.querySelector('[data-run="${z}"]'); return !!c && !!c.querySelector('[data-no-chrome]') && c.innerText.includes('Chrome을 설치한 뒤') && !!c.querySelector('[data-act=prepare]'); })()`), 3000) && runStatus(z) === 'draft' && !calls.some(([m, r]) => m === 'run.start' && r === z), { st: runStatus(z), calls });
  await shot('00-no-chrome');
  await click(`[data-run="${z}"] [data-act=cancel]`);
  await until('cancelled', () => runStatus(z) !== 'draft', 3000);
  chrome = true;

  plans.push({ login: true });
  const a = await toDraft('A상사에 12만원 세금계산서');
  await prepare(a);
  check('로그인 차례: 실행 카드가 끝나지 않고 사람 차례(turn)로 남는다', await until('login turn', () => runStatus(a) === 'turn' && S.runs.get(a)?.handoff?.kind === 'login', 5000), runStatus(a));
  await until('login card', async () => (await card(a)).handoff === 'login');
  let c = await card(a);
  check('로그인 카드: "홈택스 창에서 로그인해 주세요" + [이어서](주 버튼)·[중지], [직접 발급함] 없음', c.text.includes(HANDOFF_LOGIN.text) && c.text.includes(HANDOFF_LOGIN.note) && c.acts.some((b) => b.act === 'resume' && b.label === '이어서' && b.primary) && c.acts.some((b) => b.act === 'stop') && !c.acts.some((b) => b.act === 'manual-done'), c);
  check('로그인 차례 카드는 끝난 카드처럼 보이지 않는다(발급 완료·중지됨·확인 필요 칩이 아니다)', !/발급 완료|중지됨|취소|확인 필요/.test(c.chip), c.chip);
  check('로그인 카드에 [홈택스 창 보기]', c.acts.some((b) => b.act === 'show-browser' && b.label === '홈택스 창 보기'), c.acts);
  if (headful) {
    for (let i = 0; i < 5 && !/Finder/.test(frontApp()); i++) {
      execFileSync('osascript', ['-e', 'tell application "Finder" to activate']);
      await sleep(1500);
    }
  }
  await userClick(`[data-run="${a}"] [data-act=show-browser]`);
  check('[홈택스 창 보기] → main → 금고 browser.place(front) → 실행 Chrome 창을 앱 옆에 두고 앞으로', await until('focused', () => focusCalls.length >= 1, 3000) && focusCalls.some((x) => JSON.stringify(x) === '{"placed":true}' || JSON.stringify(x) === '{"focused":true}'), focusCalls);
  if (headful) {
    await sleep(1200);
    check('(맥, 화면) Chrome 앱이 맨 앞에 온다', /Google Chrome/.test(frontApp()), frontApp());
    S.win.show();
    S.win.focus();
    await sleep(800);
  }
  check('[홈택스 창 보기]는 실행 상태를 바꾸지 않는다', runStatus(a) === 'turn' && !calls.some(([m, r]) => m === 'run.resume' && r === a), runStatus(a));
  await shot('01-login-turn');
  await sleep(3300);
  await click(`[data-run="${a}"] [data-act=resume]`);
  await sleep(200);
  check('실제 입력 없는 [이어서]는 받지 않는다(엔진에 보내지 않음, 카드 그대로)', runStatus(a) === 'turn' && !calls.some(([m, r]) => m === 'run.resume' && r === a), calls);
  await userClick(`[data-run="${a}"] [data-act=resume]`);
  check('[이어서] → 엔진 run.resume → 준비 중으로 돌아간다', await until('resumed', () => runStatus(a) !== 'turn', 3000) && calls.some(([m, r]) => m === 'run.resume' && r === a), runStatus(a));
  await until('bar armed a', () => S.bar.snapshot().visible && S.bar.snapshot().armed, 10_000);
  const irr = S.bar.snapshot().irreversible;
  check('승인 카드 비가역 줄: "바로 발급"이 아니라 승인 뒤 간편인증을 마쳐야 발급된다고 말한다', irr === irreversibleText(SIGN_LABEL.simple_auth, true) && !/바로 발급/.test(irr), irr);
  check('로그인 뒤 게이트 → 실제 승인 바로 승인', await approveGate(a), { st: runStatus(a), bar: S.bar.snapshot().visible });
  check('승인 직후 서명 단계: 서명 차례(handoff) 전에도 카드가 발급 인증별 할 일을 바로 보인다', await until('sign now', async () => (await js<boolean>(`(() => { const c = document.querySelector('[data-run="${a}"]'); return !!c && 'signNow' in c.dataset && c.innerText.includes(${JSON.stringify(SIGN_BY_AUTH['사업자 간편인증']!.now)}); })()`)), 3000), await card(a));
  check('서명 차례: 승인 뒤에도 카드는 끝나지 않고 사람 차례(서명)', await until('sign turn', () => runStatus(a) === 'turn' && S.runs.get(a)?.handoff?.kind === 'sign', 5000), runStatus(a));
  await until('sign card', async () => (await card(a)).handoff === 'sign');
  c = await card(a);
  check('서명 카드: 실화면 문구 + [다 했어요](보조)·[중지], [직접 발급함] 없음, "다시 발급하지 않아요" 안내', c.text.includes(SIGN_BY_AUTH[S.runs.get(a)!.auth]!.text) && c.acts.some((b) => b.act === 'resume' && b.label === '다 했어요' && !b.primary) && c.acts.some((b) => b.act === 'stop') && !c.acts.some((b) => b.act === 'manual-done' || b.act === 'prepare') && c.signWait, c);
  check('서명 차례 카드는 끝난 카드처럼 보이지 않는다', !/발급 완료|중지됨|취소|확인 필요/.test(c.chip), c.chip);
  await shot('02-sign-turn');
  await sleep(500);
  engineFinishesSign(a);
  check('완료 창이 보이면 엔진이 스스로 넘어가 발급 완료([다 했어요]를 누르지 않음)', await until('done', () => runStatus(a) === 'done', 5000) && !calls.some(([m, r]) => r === a && m !== 'run.start' && m !== 'run.resume'), { st: runStatus(a), calls });
  check('사람 차례 [이어서]는 로그인 한 번뿐(run.resume 1)', calls.filter(([m, r]) => m === 'run.resume' && r === a).length === 1, calls);
  await shot('03-done');

  plans.push({ login: false, signStop: true });
  const b = await toDraft('B상사에 21만원 세금계산서');
  await prepare(b);
  check('(중지) 로그인된 상태: 바로 게이트 → 승인', await approveGate(b), runStatus(b));
  check('(중지) 서명 차례', await until('sign turn b', () => runStatus(b) === 'turn' && S.runs.get(b)?.handoff?.kind === 'sign', 5000), runStatus(b));
  await until('sign card b', async () => (await card(b)).handoff === 'sign');
  await click(`[data-run="${b}"] [data-act=stop]`);
  check('서명 차례 [중지] → 엔진 {stopped:false} → 카드는 확인 중(발급목록) + 안내, 끝난 것처럼 보이지 않는다', await until('verifying', async () => runStatus(b) === 'issuing' && (await card(b)).text.includes(STOP_AFTER_SIGN_NOTE), 3000), { st: runStatus(b), c: await card(b) });
  c = await card(b);
  check('확인 중 카드에는 다시 발급·준비 버튼이 없다', !c.acts.some((x) => ['prepare', 'again', 'reissue', 'resume', 'manual-done'].includes(x.act)), c.acts);
  await shot('04-sign-stop-verifying');
  check('확인 뒤 엔진 end → 확인 필요(발급됐는지 모름), 발급 완료라고 하지 않는다', await until('end b', () => runStatus(b) === 'attention', 5000) && S.runs.get(b)?.inDoubt === true, { st: runStatus(b) });

  plans.push({ login: true, capOnLogin: true });
  const d = await toDraft('C테크에 33만원 세금계산서');
  await prepare(d);
  check('(상한) 로그인 차례', await until('turn d', () => runStatus(d) === 'turn', 5000), runStatus(d));
  check('(상한) run.handoff_timeout → 끝 카드: 30분 문구 + "아무것도 발급하지 않았어요" + [다시 준비]', await until('cap end', async () => runStatus(d) === 'attention' && (await card(d)).text.includes(NOTE['run.handoff_timeout']!) && (await card(d)).text.includes('아무것도 발급하지 않았어요') && (await card(d)).acts.some((x) => x.act === 'handoff-again' && x.label === '다시 준비'), 5000), await card(d));
  await shot('05-cap-end');

  plans.push({ login: false });
  const before = S.runs.get(await toDraft('B상사에 44만원 세금계산서'))!;
  const m = before.id;
  check('(인증 바꿈) 초안은 지금 기본(사업자 간편인증)', before.auth === SIGN_LABEL.simple_auth, before.auth);
  const toCert = await changeAuthInSettings('cert');
  check('(인증 바꿈) 설정에 "진행 중인 작업은 원래 인증으로 끝내요" + [바꾸기] → O-03 → 공동인증서 → 요약 [확인했어요]', toCert.note && toCert.atAuth && toCert.atSummary && toCert.ended, toCert);
  const profileSign = async () => ((await S.host.rpc('db.query.profiles.list')) as Array<{ kind: string; signMethod: string | null }>).find((x) => x.kind === 'business')?.signMethod;
  check('(인증 바꿈) 설정 [바꾸기] → 프로필 signMethod cert', await until('profile cert', async () => (await profileSign()) === 'cert', 5000), await profileSign());
  check('(인증 바꿈) 아직 시작하지 않은 초안은 새 기본을 보인다', await until('draft synced', () => S.runs.get(m)?.auth === SIGN_LABEL.cert, 5000), S.runs.get(m)?.auth);
  await userClick('#rail [data-view=chat]');
  await until('chat', () => js<boolean>(`!!document.querySelector('[data-run="${m}"] [data-act=prepare]')`), 5000);
  await prepare(m);
  check('(인증 바꿈) 승인 → 서명 단계 안내는 엔진이 누를 인증(공동·금융인증서)과 같다', (await approveGate(m)) && (await until('sign now cert', () => S.runs.get(m)?.steps[5]?.note === SIGN_BY_AUTH[SIGN_LABEL.cert]!.now, 5000)) && (await profileSign()) === 'cert', { note: S.runs.get(m)?.steps[5]?.note, auth: S.runs.get(m)?.auth });
  await shot('06-auth-changed-sign-now');
  const toSimple = await changeAuthInSettings('simple');
  check('(인증 바꿈) 진행 중에 다시 [바꾸기] → 간편인증: 진행 중인 실행은 시작 때 값 그대로(설정 문구 "진행 중인 작업은 원래 인증으로")', toSimple.atSummary && toSimple.ended && await until('profile simple', async () => (await profileSign()) === 'simple_auth', 5000) && S.runs.get(m)?.auth === SIGN_LABEL.cert, S.runs.get(m)?.auth);
  engineFinishesSign(m);
  await until('done m', () => runStatus(m) === 'done', 5000);
  await userClick('#rail [data-view=chat]');
}

app.whenReady().then(async () => {
  await fs.mkdir(OUT, { recursive: true });
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, preparePerMin: 100, show: headful, headful, daemon: false, onboarding: true, chromeReady: () => chrome });
    S.win.webContents.setBackgroundThrottling(false);
    S.win.setIgnoreMouseEvents(true);
    await flow();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok  (스크린샷: ${OUT})`);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
