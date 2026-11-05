// 셸 온보딩 e2e(M4-2, 08 §4 O-01~O-06·동의 4종): 실제 렌더러·preload·main 처리기로 온보딩을 끝까지 간다(fixture 모드, 목업 어댑터).
// 실행: electron apps/desktop/dist/shell-onboarding-e2e.js → reports/raw/m4-2-onboarding.json. 앱 폴더·키체인을 쓰지 않는다.
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Profile as DbProfile } from '@sax/db';
import { CONSENT_NOTICES } from './onboarding.ts';
import { MOCK_CONSENT_CONFIG } from './onboarding-mock.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-onb-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const OUT = path.resolve(import.meta.dirname, '../../../reports/raw');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
const step = () => js<string | null>(`document.querySelector('section.onb')?.dataset.onboarding ?? null`);
/** main이 본 실제 입력(ADR-027 결정 8) 뒤 그 버튼을 누른다. */
async function press(sel: string) {
  S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(30);
  const ok = await js<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no button ${sel}`);
}
async function reply(sel: string, next: string) {
  await press(sel);
  return until(`step ${next}`, async () => (await step()) === next);
}
const callErr = (m: string, p: unknown) => js<string>(`window.sax.call(${JSON.stringify(m)}, ${JSON.stringify(p)}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
const noPasswordInputs = () => js<boolean>(`!document.querySelector('input[type=password]')`);

async function main() {
  S = await startShell({ width: 1280, height: 820, show: false, onboarding: true });
  S.win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer] ${e.message}`);
  });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1');

  // ④ 약관
  check('처음 화면은 약관(④) 동의 카드, 판은 숨김, 지난 타임라인 없음', (await step()) === 'terms' && (await js<boolean>(`document.querySelector('[data-board]').hidden && !document.querySelector('.sx-card [data-act]') && !document.querySelector('.sx-me')`)));
  const terms = await js<{ key: string; version: string; draft: string; buttons: string[] }>(`(() => { const c = document.querySelector('[data-consent]'); return { key: c.dataset.consent, version: c.dataset.consentVersion, draft: c.querySelector('.onb-draft')?.textContent ?? '', buttons: [...c.querySelectorAll('button')].map((b) => b.textContent) }; })()`);
  check('동의 카드: 판 붙은 키(consent.terms f06-pre.1)·"F-06 초안 전" 표시·버튼 하나(묶음 동의 없음)', terms.key === 'consent.terms' && terms.version === CONSENT_NOTICES.terms.version && terms.draft === 'F-06 초안 전 문구' && terms.buttons.length === 1, terms);
  check('약관 동의 전에는 입력창이 막혀 있고 main도 요청을 받지 않는다(onboarding_terms)', (await js<boolean>(`document.querySelector('#composer').disabled`)) && (await callErr('request.send', { text: '세금계산서', vat: null })) === 'onboarding_terms');
  await sleep(3_100);
  check('실제 입력 없이 온 동의는 받지 않는다(gesture_required, 단계 그대로)', (await callErr('onboarding.reply', { step: 'terms', choice: 'agree' })) === 'gesture_required' && (await step()) === 'terms');
  check('표에 없는 답·지난 단계 답은 거부(bad_request·stale_step)', (await callErr('onboarding.reply', { step: 'terms', choice: 'agreeAll' })) === 'bad_request');
  check('④ 동의 → O-01 환영(칩 셋), 입력창이 열린다', (await reply('[data-onb=agree]', 'welcome')) && !(await js<boolean>(`document.querySelector('#composer').disabled`)));

  // O-02
  check('[사업자등록증 올리기] → 인식 카드: 상호·진위확인 배지와 출처(국세청 조회)·90일 고지', (await reply('[data-onb=upload]', 'biz-confirm')) && (await js<boolean>(`(() => { const t = document.querySelector('[data-onb-step=biz-confirm]').textContent; return t.includes('가나다컴퍼니') && t.includes('계속사업자 · 일반과세자') && t.includes('국세청 조회') && t.includes('90일 뒤에'); })()`)));
  await press('[data-onb=edit]');
  await js(`(() => { const i = document.querySelector('[data-onb-step=biz-confirm] input[name=email]'); i.value = 'billing@ganada.example'; })()`);
  await press('[data-onb=save]');
  check('[고칠게요] → 그 자리에서 고치고 저장', await until('edited', async () => js<boolean>(`!document.querySelector('[data-onb-step=biz-confirm] form') && document.querySelector('[data-onb-step=biz-confirm]').textContent.includes('billing@ganada.example')`)));

  // O-03
  check('[맞아요] → 발급 인증 4종 + 잘 모르겠어요·나중에', (await reply('[data-onb=confirm]', 'auth')) && (await js<number>(`document.querySelectorAll('.onb-auth').length`)) === 4);
  await press('[data-onb=cert]');
  check('공동인증서 → 이 PC에서 찾은 인증서 목록, 30일 안 만료 경고', await js<boolean>(`(() => { const l = document.querySelector('[data-onb-certs]'); return !!l && l.querySelectorAll('[data-cert]').length === 2 && l.textContent.includes('30일 안에 만료돼요'); })()`));
  check('보안카드 → ① 위임 등록 동의 카드(범위 고지·인증서 비밀번호 저장 안 함, 다른 인증 버튼 동등)', (await reply('[data-onb=card]', 'delegation')) && (await js<boolean>(`(() => { const c = document.querySelector('[data-consent="consent.delegation"]'); const t = c.textContent; return t.includes('악성코드로부터는 보호하지 못해요') && t.includes('인증서 비밀번호는 저장하지 않아요') && !!c.querySelector('[data-onb=switch]'); })()`)));
  check('비밀 입력 칸은 앱 화면에 없다(금고 창에서만, ADR-025·026)', await noPasswordInputs());

  // ②③
  check('① 동의 → 금고 등록(목업) → ② 모델 국외 이전: 처리자 표는 설정 데이터 그대로', (await reply('[data-onb=agree]', 'model')) && (await js<{ v: string; rows: number; first: string }>(`(() => { const t = document.querySelector('[data-processors]'); return { v: t.dataset.processors, rows: t.querySelectorAll('tbody tr').length, first: t.querySelector('tbody td').textContent }; })()`).then((t) => t.v === MOCK_CONSENT_CONFIG.processorsVersion && t.rows === MOCK_CONSENT_CONFIG.processors.length && t.first === MOCK_CONSENT_CONFIG.processors[0]!.name)));
  check('② [모델 없이 쓸게요] → ③ 사용 기록: 기본 꺼짐([끄고 계속]이 주 버튼)', (await reply('[data-onb=decline]', 'telemetry')) && (await js<boolean>(`document.querySelector('[data-onb=off]').classList.contains('sx-btn-primary')`)));

  // O-04·O-05
  await reply('[data-onb=off]', 'tasks');
  await press('[data-task=H-02]');
  check('곧 되는 일(회색 칩)은 고를 수 없고 "지원되면 알려 드릴게요"', await js<boolean>(`document.querySelector('#toast').textContent.includes('지원되면') && document.querySelector('[data-onb=submit]').disabled`));
  await press('[data-task=H-01]');
  await press('[data-task=H-03]');
  check('세금계산서를 고르면 O-05 거래처', await reply('[data-onb=submit]', 'counterparties'));

  // O-06
  check('[나중에] → O-06 요약: 등록 내용 + 하는 일·하지 않는 일(F-06 자리표시) + 건너뛴 항목 안내', (await reply('[data-onb=later]', 'summary')) && (await js<boolean>(`(() => { const t = document.querySelector('[data-onb-step=summary]').textContent; return t.includes('보안카드 · 금고에 등록함') && t.includes('세금계산서 발급·메일 전송, 사업자등록증명') && !!document.querySelector('[data-onb-scope] .onb-draft') && t.includes('이번 달 할 일에'); })()`)));
  check('[확인했어요] → 프로필 저장(엔진 profile.upsert, 고친 이메일·보안카드)', (await reply('[data-onb=ok]', 'first')) && (await S.host.rpc('db.query.profiles.list').then((ps) => (ps as DbProfile[]).some((p) => p.kind === 'business' && p.email === 'billing@ganada.example' && p.signMethod === 'security_card'))));
  const meBefore = await js<number>(`document.querySelectorAll('.sx-me').length`);
  await press('[data-onb=try]');
  await until('done', async () => (await js<boolean>(`!document.querySelector('[data-onb-step]')`)) === true);
  check('첫 작업 [지금 해 보기] → 입력창에 채우기만(보내지 않음)', (await js<string>(`document.querySelector('#composer').value`)) === '사업자등록증명 떼 줘' && (await js<number>(`document.querySelectorAll('.sx-me').length`)) === meBefore + 1 && S.runs.list().length === 0);
  check('끝나면 판이 보이고 건너뛴 거래처 등록이 "등록 할 일"로 남는다', await until('board setup', async () => js<boolean>(`!document.querySelector('[data-board]').hidden && !!document.querySelector('[data-setup=counterparties]')`)));
  S.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(30);
  check('온보딩이 끝난 뒤 답은 받지 않는다(실제 입력이 있어도 onboarding_done)', (await callErr('onboarding.reply', { step: 'first', choice: 'try' })) === 'onboarding_done');
  check('끝까지 비밀 입력 칸 없음', await noPasswordInputs());

  await fs.mkdir(path.join(OUT, 'm4-2'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'm4-2', 'onboarding-done.png'), (await S.win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(OUT, 'm4-2-onboarding.json'), JSON.stringify({ checks: results }, null, 2));
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`);
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
