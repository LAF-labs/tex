// 셸 온보딩 e2e(M4-2, 08 §4 O-01~O-06·동의 4종): 실제 렌더러·preload·main 처리기로 온보딩을 끝까지 간다(fixture 모드, 목업 어댑터).
// 실행: electron apps/desktop/e2e-dist/shell-onboarding-e2e.js → reports/raw/m4-2-onboarding.json. 앱 폴더·키체인을 쓰지 않는다.
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Profile as DbProfile } from '@sax/db';
import { CONSENT_NOTICES } from '../dist/onboarding.js';
import { MOCK_CONSENT_CONFIG } from '../dist/onboarding-mock.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

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
  S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, onboarding: true });
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
  const welcome = await js<string>(`[...document.querySelectorAll('.onb .sx-app')].at(-1).textContent`);
  check('환영 문구는 세금계산서 발급만 말한다(이 빌드는 증명서를 떼지 못한다)', welcome.includes('세금계산서 발급') && !welcome.includes('증명서'), welcome);

  // O-02
  check('[사업자등록증 올리기] → 인식 카드: 상호·진위확인 배지와 출처(국세청 조회)·90일 고지', (await reply('[data-onb=upload]', 'biz-confirm')) && (await js<boolean>(`(() => { const t = document.querySelector('[data-onb-step=biz-confirm]').textContent; return t.includes('가나다컴퍼니') && t.includes('계속사업자 · 일반과세자') && t.includes('국세청 조회') && t.includes('90일 뒤에'); })()`)));
  const privacy = await js<string>(`document.querySelector('[data-onb-step=biz-confirm]').textContent`);
  check('인식 카드 개인정보 줄: 등록증은 이 PC 안에서만 읽고, 진위확인으로 보낸다는 약속은 없다(제품 빌드는 보내지 않는다)', privacy.includes('등록증 파일은 이 PC 안에서만 읽어요') && !privacy.includes('진위확인에 보내요') && !privacy.includes('우리 서버'), privacy);
  await press('[data-onb=edit]');
  await js(`(() => { const i = document.querySelector('[data-onb-step=biz-confirm] input[name=email]'); i.value = 'billing@ganada.example'; })()`);
  await press('[data-onb=save]');
  check('[고칠게요] → 그 자리에서 고치고 저장', await until('edited', async () => js<boolean>(`!document.querySelector('[data-onb-step=biz-confirm] form') && document.querySelector('[data-onb-step=biz-confirm]').textContent.includes('billing@ganada.example')`)));

  // O-03
  check('[맞아요] → 발급 인증 4종 + 잘 모르겠어요·나중에', (await reply('[data-onb=confirm]', 'auth')) && (await js<number>(`document.querySelectorAll('.onb-auth').length`)) === 4);
  const appTypes = /알아서|대신 입력|앱이 입력|등록하면/;
  const auths = await js<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('.onb-auth')].map((b) => [b.dataset.onb, b.querySelector('.sx-meta').textContent]))`);
  check('인증 설명은 발급할 때 사람이 하는 일: 보안카드는 번호를 직접 넣는다, 앱이 대신 넣는다는 설명은 없다', auths.card!.includes('발급할 때마다') && auths.card!.includes('보안카드 번호를 직접 넣어요') && Object.values(auths).every((t) => !appTypes.test(t)), auths);
  await press('[data-onb=unsure]');
  await until('unsure note', async () => js<boolean>(`!!document.querySelector('[data-onb-step=auth] .sx-note')`));
  const unsure = await js<string>(`document.querySelector('[data-onb-step=auth] .sx-note')?.textContent ?? ''`);
  check('[잘 모르겠어요] 설명도 같다: 보안카드 번호는 직접 넣고, 앱이 넣는다는 말이 없다', unsure.includes('보안카드 번호를 직접 넣어요') && !appTypes.test(unsure), unsure);
  await press('[data-onb=cert]');
  check('공동인증서 → 이 PC에서 찾은 인증서 목록, 30일 안 만료 경고', await js<boolean>(`(() => { const l = document.querySelector('[data-onb-certs]'); return !!l && l.querySelectorAll('[data-cert]').length === 2 && l.textContent.includes('30일 안에 만료돼요'); })()`));

  // ②③
  check('보안카드 → 금고 위임 단계 없이 바로 ② 모델 국외 이전: 처리자 표는 설정 데이터 그대로', (await reply('[data-onb=card]', 'model')) && !(await js<boolean>(`!!document.querySelector('[data-consent="consent.delegation"]')`)) && (await js<{ v: string; rows: number; first: string }>(`(() => { const t = document.querySelector('[data-processors]'); return { v: t.dataset.processors, rows: t.querySelectorAll('tbody tr').length, first: t.querySelector('tbody td').textContent }; })()`).then((t) => t.v === MOCK_CONSENT_CONFIG.processorsVersion && t.rows === MOCK_CONSENT_CONFIG.processors.length && t.first === MOCK_CONSENT_CONFIG.processors[0]!.name)));
  check('② 모델 동의는 필수: 버튼은 [동의하고 계속] 하나(거절 선택지 없음), main도 거절 답을 받지 않는다(bad_request)', (await js<string[]>(`[...document.querySelector('[data-consent="consent.model"]').querySelectorAll('button')].map((b) => b.textContent)`)).join() === '동의하고 계속' && (await callErr('onboarding.reply', { step: 'model', choice: 'decline' })) === 'bad_request');
  check('② [동의하고 계속] → ③ 사용 기록: 기본 꺼짐([끄고 계속]이 주 버튼)', (await reply('[data-onb=agree]', 'telemetry')) && (await js<boolean>(`document.querySelector('[data-onb=off]').classList.contains('sx-btn-primary')`)));

  // O-04·O-05
  await reply('[data-onb=off]', 'tasks');
  await press('[data-task=H-02]');
  check('곧 되는 일(회색 칩)은 고를 수 없고 "지원되면 알려 드릴게요"', await js<boolean>(`document.querySelector('#toast').textContent.includes('지원되면') && document.querySelector('[data-onb=submit]').disabled`));
  await press('[data-task=H-03]');
  await press('[data-task=H-04]');
  check('사업자등록증명·납세증명서도 곧 되는 일(회색 칩): 눌러도 고를 수 없다', await js<boolean>(`['H-03', 'H-04'].every((id) => document.querySelector('[data-task=' + id + ']').classList.contains('is-soon')) && document.querySelector('[data-onb=submit]').disabled`));
  await press('[data-task=H-01]');
  check('세금계산서를 고르면 O-05 거래처', await reply('[data-onb=submit]', 'counterparties'));

  // O-06
  check('[나중에] → O-06 요약: 등록 내용 + 하는 일·하지 않는 일(F-06 자리표시) + 건너뛴 항목 안내', (await reply('[data-onb=later]', 'summary')) && (await js<boolean>(`(() => { const t = document.querySelector('[data-onb-step=summary]').textContent; return t.includes('보안카드') && !t.includes('금고에 등록함') && !!document.querySelector('[data-onb-scope] .onb-draft') && t.includes('이번 달 할 일에'); })()`)));
  const scope = await js<string[]>(`[...document.querySelectorAll('[data-onb-scope] li')].map((l) => l.textContent)`);
  check('요약 "지금 되는 일"은 세금계산서뿐이고, 하는 일 목록 어디에도 증명서를 떼 준다는 말이 없다', scope[0] === '지금 되는 일: 세금계산서 발급·메일 전송' && !scope.join().includes('증명'), scope);
  check('[확인했어요] → 프로필 저장(엔진 profile.upsert, 고친 이메일·보안카드)', (await reply('[data-onb=ok]', 'first')) && (await S.host.rpc('db.query.profiles.list').then((ps) => (ps as DbProfile[]).some((p) => p.kind === 'business' && p.email === 'billing@ganada.example' && p.signMethod === 'security_card'))));
  // 저장은 실제 엔진 명령으로 DB에(onboarding-store.ts, 엔진 #91·db #53). main만 부를 수 있다.
  {
    const host = S.host;
    const biz = ((await host.rpc('db.query.profiles.list')) as DbProfile[]).find((p) => p.kind === 'business' && p.email === 'billing@ganada.example')!;
    const latest = (kind: string) => host.rpc('consent.latest', { profileId: biz.id, kind }) as Promise<{ choice: string; via: string; noticeVersion: string; processorsVersion: string | null } | null>;
    const [terms, deleg, model, tele, orphan] = await Promise.all([latest('terms'), latest('delegation'), latest('model'), latest('telemetry'), host.rpc('consent.latest', { profileId: null, kind: 'terms' })]);
    check(
      '동의 레코드가 DB에 쌓여 프로필로 이어진다(약관 동의·모델 동의는 고지 판·처리자 표 판과 함께·사용 기록 끔). 보안카드여도 위임 동의는 없다',
      terms?.choice === 'agreed' && terms.noticeVersion === CONSENT_NOTICES.terms.version && deleg === null && model?.choice === 'agreed' && model.noticeVersion === CONSENT_NOTICES.model.version && model.processorsVersion === MOCK_CONSENT_CONFIG.processorsVersion && tele?.choice === 'declined' && orphan === null,
      { terms, deleg, model, tele, orphan },
    );
    const st = (await host.rpc('onboarding.load', { profileKind: 'business' })) as { step: string; profileId: string | null } | null;
    check('이어 하기는 DB 한 행(앱 폴더 JSON 없음)', st?.step === 'first' && st.profileId === biz.id, st && { step: st.step, profileId: st.profileId });
  }
  const first = await js<{ q: string; chips: string[] }>(`({ q: [...document.querySelectorAll('.onb .sx-app')].at(-1).textContent, chips: [...document.querySelectorAll('[data-onb-step=first] button')].map((b) => b.textContent) })`);
  check('첫 작업: 세금계산서 1건을 같이 발급하자고 묻고, 버튼은 [지금 해 보기]·[나중에] 둘', first.q.includes('세금계산서') && !first.q.includes('증명') && first.chips.join() === '지금 해 보기,나중에', first);
  const meBefore = await js<number>(`document.querySelectorAll('.sx-me').length`);
  await press('[data-onb=try]');
  await until('done', async () => (await js<boolean>(`!document.querySelector('[data-onb-step]')`)) === true);
  check('첫 작업 [지금 해 보기] → 입력창에 채우기만(보내지 않음)', (await js<string>(`document.querySelector('#composer').value`)) === '세금계산서 발급해 줘' && (await js<number>(`document.querySelectorAll('.sx-me').length`)) === meBefore + 1 && S.runs.list().length === 0);
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
