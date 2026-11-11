// H-01 리허설 후속(reports/H01-rehearsal-2026-11-11.md F-02·03·04·07·09·10·11·12·13·16 + 핸드오프 끝 안내, 부장 지시 2026-11-11).
// 판정 모듈은 직접, 렌더러·main 배선은 소스로 본다(Electron 없이). 사람 속도 흐름은 e2e/shell-rehearsal-e2e.ts가 REPRO/FIXED로 본다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { RateWindow } from '../apps/desktop/src/gesture.ts';
import { TRY_FIRST_FILL } from '../apps/desktop/src/onboarding.ts';
import { answersPending, cpNameFromAnswer, interpret, NO_CP_TEXT, parseRegex, UNKNOWN_CP_TEXT, type Counterparty } from '../apps/desktop/src/shell-model.ts';
import { GATELESS_STREAK_MAX, HANDOFF_END_NEXT, HANDOFF_END_NOTE, NOTE, PREPARE_PAUSE_MS, ShellRuns } from '../apps/desktop/src/shell-runs.ts';

const read = (f: string) => fs.readFileSync(new URL(`../apps/desktop/${f}`, import.meta.url), 'utf8');
const A: Counterparty = { id: 'cp-a', name: 'A상사', bizNo: '2148651233', rep: '', email: 'tax@a.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null };
class FakeHost extends EventEmitter {
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(): Promise<unknown> {
    return {};
  }
}
const make = (cps: Counterparty[], now = () => 0) => {
  const host = new FakeHost();
  return { host, runs: new ShellRuns(host, { counterparties: () => cps, auth: () => '' }, now) };
};

describe('F-02·F-03 거래처 없음·장부에 없는 이름', () => {
  it('F-02 거래처가 0곳이면 칩 대신 "먼저 거래처를 추가해 주세요" + [거래처 추가], 받아 둔 금액은 잇는다', () => {
    const { runs } = make([]);
    const r = interpret('100만원 세금계산서', null, 'business', runs);
    assert.deepEqual(r, { kind: 'say', text: NO_CP_TEXT, addCp: { name: '' } });
    assert.deepEqual([runs.pending.asked, runs.pending.amount], ['counterparty', 1_000_000]);
  });

  it('F-03 거래처를 묻는 중 장부에 없는 이름: 되묻기를 끊지 않고 "장부에 없는 거래처예요" + [거래처 추가](이름 채움)', () => {
    const { runs } = make([A]);
    assert.equal(interpret('100만원 세금계산서', null, 'business', runs).kind, 'say');
    const p = parseRegex('새빛상사요', runs.counterparties);
    assert.equal(answersPending(p, runs, '새빛상사요'), true, '모델이 unknown이어도 대화 응대(chat.respond)로 보내지 않는다');
    assert.equal(answersPending(p, runs), false, '문장 없이는 판단하지 않는다(setupGate)');
    const r = interpret('새빛상사요', null, 'business', runs, p);
    assert.deepEqual(r, { kind: 'say', text: UNKNOWN_CP_TEXT('새빛상사'), chips: [{ label: 'A상사', text: 'A상사' }], addCp: { name: '새빛상사' } });
    assert.equal(runs.pending.asked, 'counterparty');
    // 추가한 뒤 그 이름으로 답하면 앞에서 받은 금액으로 카드
    const B: Counterparty = { ...A, id: 'cp-b', name: '새빛상사', bizNo: '1068114580' };
    runs.counterparties.push(B);
    const d = interpret('새빛상사', null, 'business', runs);
    assert.ok(d.kind === 'draft' && d.run.counterparty.id === 'cp-b' && d.run.amount === 1_000_000);
  });

  it('이름 후보: 조사·"요"·"로 해 줘"를 떼고, 취소·금액·서류 낱말·긴 문장은 이름이 아니다', () => {
    assert.equal(cpNameFromAnswer('새빛상사요'), '새빛상사');
    assert.equal(cpNameFromAnswer('(주)가나다로 해 줘'), '(주)가나다');
    assert.equal(cpNameFromAnswer('가나 전자에'), '가나 전자');
    assert.equal(cpNameFromAnswer('미래로'), '미래로');
    for (const t of ['취소', '아니요', '100만원', '사업자등록증명 떼 줘', '세금계산서', '오늘 날씨가 어때 보여 정말로', '', '<b>x</b>']) assert.equal(cpNameFromAnswer(t), null, t);
  });

  it('렌더러: [거래처 추가]는 거래처 화면의 추가 폼(이름 채움), 추가하면 대화로 돌아와 그 이름을 입력창에 채운다', () => {
    const s = read('static/shell/shell.js');
    assert.match(s, /if \(r\.addCp\) box\.append\(h\('div', \{ class: 'sx-actions' \}, btn\('거래처 추가', \(\) => addCpFromAsk\(r\.addCp\.name\), 'sx-btn-primary', \{ 'data-act': 'ask-cp-add' \}\)\)\);/);
    assert.match(s, /openPanel\(\{ kind: 'cp-edit', id: null, name: String\(name \?\? ''\), ask: true \}\);/);
    assert.match(s, /if \(!c && add\?\.ask\) \{\s*\/\/[^\n]*\n\s*await go\('chat'\);\s*fillComposer\(/);
    assert.match(s, /field\('상호', 'name', c\?\.name \?\? add\?\.name,/);
    assert.match(read('src/shell-app.ts'), /answersPending\(local, runs, text\)/);
  });
});

describe('F-04 발급 PDF가 이 PC에 없다(화면만)', () => {
  it('발급 끝: 문서함 줄·결과에 noFile, 화면은 [PDF 열기]·[열기]·[다시 발급] 대신 홈택스 발급목록 안내', async () => {
    const { host, runs } = make([A]);
    const docs: Array<{ noFile?: boolean }> = [];
    runs.on('doc', (d) => docs.push(d));
    const d = runs.createDraft(A, 1000, null);
    await runs.prepare(d.id);
    host.emit('run', { runId: d.id, type: 'end', status: 'success', approvalNo: '20261111-1', mailConfirmed: true });
    assert.equal(runs.get(d.id)!.result!.noFile, true);
    assert.equal(docs[0]!.noFile, true);
    const v = read('static/shell/shell-views.js');
    assert.match(v, /export const NO_FILE_TEXT = '세금계산서 PDF는 홈택스 발급목록에서 확인할 수 있어요\.';/);
    assert.match(v, /r\.noFile \? null : btn\('PDF 열기'/);
    assert.match(v, /run\.result\.noFile \? line\(NO_FILE_TEXT, true\)/);
    assert.match(v, /doc\.noFile \? null : btn\('열기'/);
    assert.match(v, /doc\.source === '앱이 발급' && !doc\.noFile \? btn\('다시 발급'/);
  });
});

describe('F-07 [홈택스에서 준비] 상한은 이유와 남은 초', () => {
  it('RateWindow.waitMs: 다음 허용까지 남은 시간, 세지 않는다', () => {
    const w = new RateWindow(3, 60_000);
    for (const t of [0, 10_000, 20_000]) assert.ok(w.take(t));
    assert.equal(w.waitMs(30_000), 30_000);
    assert.equal(w.take(30_000), false);
    assert.equal(w.waitMs(60_000), 0);
  });
  it('연달아 멈춤: prepareWaitMs가 남은 시간, 지나면 0', async () => {
    let now = 0;
    const { host, runs } = make([A], () => now);
    for (let i = 0; i < GATELESS_STREAK_MAX; i++) {
      const d = runs.createDraft(A, 1000, null);
      await runs.prepare(d.id);
      host.emit('run', { runId: d.id, type: 'end', status: 'failed', code: 'assert.supplier_mismatch' });
    }
    now += 15_000;
    assert.equal(runs.prepareWaitMs(), PREPARE_PAUSE_MS - 15_000);
    now += PREPARE_PAUSE_MS;
    assert.equal(runs.prepareWaitMs(), 0);
  });
  it('main은 이유·초를 코드에 붙이고(throttled.streak:N / throttled.rate:N), 화면은 결속과 상한을 다른 문장으로', () => {
    const app = read('src/shell-app.ts');
    assert.match(app, /throw new Error\(`throttled\.\$\{why\}:\$\{Math\.max\(1, Math\.ceil\(/);
    const s = read('static/shell/shell.js');
    assert.match(s, /const m = \/\^throttled\\\.\(streak\|rate\):\(\\d\{1,3\}\)\$\/\.exec\(c\);/);
    assert.match(s, /\$\{m\[2\]\}초 뒤에 다시 눌러 주세요/);
    assert.match(s, /if \(c === 'gesture_required'\) return '버튼 클릭을 확인하지 못했어요\. \[홈택스에서 준비\]를 한 번 더 눌러 주세요\.';/);
  });
});

describe('F-09·F-10·F-13', () => {
  it('F-09 login.not_implemented는 내 사업장의 발급 인증 [바꾸기]를 가리킨다', () => {
    assert.match(NOTE['login.not_implemented']!, /내 사업장 화면의 발급 인증 \[바꾸기\]/);
  });
  it('F-10 초안: 오늘 같은 거래처·같은 합계로 발급을 마쳤으면 dupToday, 금액을 고치면 다시 본다', async () => {
    const { host, runs } = make([A]);
    const d1 = runs.createDraft(A, 1000, null);
    assert.equal(d1.dupToday, false);
    await runs.prepare(d1.id);
    host.emit('run', { runId: d1.id, type: 'end', status: 'success', approvalNo: 'x-1', mailConfirmed: true });
    const d2 = runs.createDraft(A, 1000, null);
    assert.equal(d2.dupToday, true);
    assert.equal(runs.updateDraft(d2.id, { amount: 2000 }).dupToday, false);
    assert.equal(runs.updateDraft(d2.id, { amount: 1000 }).dupToday, true);
    assert.match(read('static/shell/shell-views.js'), /run\.dupToday \? h\('div', \{ 'data-dup-today': '' \}, note\(DUP_TODAY_TEXT, true\)\) : null,/);
  });
  it('F-13 O-06 [지금 해 보기]는 세금계산서로 채운다', () => {
    assert.equal(TRY_FIRST_FILL, '세금계산서 발급해 줘');
  });
});

describe('F-11·F-12·F-16 화면 배선', () => {
  it('F-11 승인 카드: 활성화 순간 커서가 승인 버튼 위면 "한 번 더 눌러 주세요"(무장·결속 규칙은 그대로, reset 그대로)', () => {
    const bar = read('src/approval-bar.ts');
    assert.match(bar, /win\.on\('focus', reset\('activate'\)\)/);
    assert.match(bar, /why === 'activate' && this\.shown && this\.pointerOn\('approve'\) \? BAR_AGAIN_TEXT : null/);
    assert.match(read('src/approval-gate.ts'), /export const BAR_AGAIN_TEXT = '창을 앞으로 가져오는 클릭이었어요\. 한 번 더 눌러 주세요';/);
  });
  it('F-11 내 차례 카드: main은 활성화 때 커서 자리만 알리고, 렌더러는 그 버튼 클릭이 오지 않았을 때만 카드에 한 줄', () => {
    const app = read('src/shell-app.ts');
    assert.match(app, /if \(x >= 0 && y >= 0 && x < c\.width && y < c\.height\) send\(\{ type: 'activated', x, y \}\);/);
    const s = read('static/shell/shell.js');
    assert.match(s, /if \(!b \|\| !card \|\| !\['turn', 'waiting'\]\.includes\(card\.dataset\.status\)\) return;/);
    assert.match(s, /if \(lastPointerDown\.t >= at && b\.contains\(lastPointerDown\.el\)\) return;/);
    assert.match(s, /if \(ev\.type === 'activated'\) return onActivated\(ev\.x, ev\.y\);/);
  });
  it('F-12 온보딩 거래처 단계면 거래처 화면에 [대화로 돌아가기] 띠', () => {
    assert.match(read('static/shell/shell.js'), /state\.onb\?\.step === 'counterparties'\s*\?\s*h\('div', \{ class: 'sx-note', 'data-onb-band': 'cps' \}[^\n]*btn\('대화로 돌아가기', \(\) => go\('chat'\)/);
  });
  it('F-16 incident.open이 실패하면 incidentId를 되돌린다', () => {
    assert.match(read('static/shell/shell.js'), /void call\('incident\.open', \{ id: next \}\)\.catch\(\(\) => \{\s*if \(incidentId === next\) incidentId = null;\s*\}\);/);
  });
});

describe('핸드오프로 끝남(end status handoff, 재개 불가)', () => {
  it('승인 전이면 무슨 일인지 + [다시 준비]·[홈택스에서 직접 발급]', async () => {
    const { host, runs } = make([A]);
    const d = runs.createDraft(A, 1000, null);
    await runs.prepare(d.id);
    host.emit('run', { runId: d.id, type: 'end', status: 'handoff', code: 'checkpoint.s0' });
    const r = runs.get(d.id)!;
    assert.deepEqual([r.status, r.handoffEnd, r.stoppedNote], ['attention', true, `${HANDOFF_END_NOTE} ${HANDOFF_END_NEXT}`]);
    const v = read('static/shell/shell-views.js');
    assert.match(v, /btn\('다시 준비', \(\) => act\.again\(run\), 'sx-btn-primary', \{ 'data-act': 'handoff-again' \}\), btn\('홈택스에서 직접 발급', \(\) => act\.open\(run\.id\), '', \{ 'data-act': 'handoff-manual' \}\)/);
  });
  it('알려진 코드면 그 문구 + 다음 할 일', async () => {
    const { host, runs } = make([A]);
    const d = runs.createDraft(A, 1000, null);
    await runs.prepare(d.id);
    host.emit('run', { runId: d.id, type: 'end', status: 'handoff', code: 'login.not_implemented' });
    assert.equal(runs.get(d.id)!.stoppedNote, `${NOTE['login.not_implemented']} ${HANDOFF_END_NEXT}`);
  });
  it('게이트 뒤 단계에서 넘겨받은 뒤 끝나면 "발급하지 않았어요"를 말하지 않는다(handoffEnd 아님)', async () => {
    const { host, runs } = make([A]);
    const d = runs.createDraft(A, 1000, null);
    await runs.prepare(d.id);
    host.emit('run', { runId: d.id, type: 'handoff', phase: 'mail' });
    host.emit('run', { runId: d.id, type: 'end', status: 'handoff', code: 'verify.unknown' });
    const r = runs.get(d.id)!;
    assert.ok(!r.handoffEnd && !String(r.stoppedNote).includes(HANDOFF_END_NOTE));
  });
});
