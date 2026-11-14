// 품목이 비어 H-01이 실행에서야 멈추던 것(리허설 세션 발견 2026-11-11, 부장 지시): 저장 품목이 없는 거래처는 카드 전에 품목을 묻고,
// 문장에 품목이 있으면 그것을 쓰고, 카드에서 품목·받는 이메일을 고치고, 품목 없이는 준비하지 않으며, 처음 쓴 품목은 저장 품목으로 남긴다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { answersPending, ASK_ITEM_TEXT, cleanItem, extractItem, interpret, parseRegex, type Counterparty } from '../apps/desktop/src/shell-model.ts';
import { NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';
import { certItem, CP_FIELD_MAX } from '../apps/desktop/src/counterparty-book.ts';

const cp = (o: Partial<Counterparty>): Counterparty => ({ id: 'cp-x', name: '일호유통', bizNo: '2148651233', rep: '', email: 'tax@ilho.example', item: '', status: '계속사업자', checkedOn: '', lastIssuedOn: null, ...o });
const NO_ITEM = cp({});
const WITH_ITEM = cp({ id: 'cp-y', name: 'A상사', bizNo: '1234567891', item: '경영 컨설팅' });
const OTHER = cp({ id: 'cp-z', name: 'B상사', bizNo: '1068114580', email: 'b@b.example', item: '사무용품' });
const CPS = [NO_ITEM, WITH_ITEM, OTHER];

class FakeHost extends EventEmitter {
  starts: Array<Record<string, unknown>> = [];
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(m: string, p: Record<string, unknown>): Promise<unknown> {
    if (m === 'run.start') this.starts.push(p);
    return {};
  }
}
const make = () => {
  const host = new FakeHost();
  return { host, runs: new ShellRuns(host as never, { counterparties: () => CPS, auth: () => '사업자 간편인증' }) };
};
const say = (runs: ShellRuns, text: string) => interpret(text, null, 'business', runs, parseRegex(text, CPS));

describe('문장에서 품목 뽑기', () => {
  it('거래처·금액·요청 낱말·조사를 빼고 남은 낱말', () => {
    assert.equal(extractItem('일호유통에 컨설팅 1000원', '일호유통'), '컨설팅');
    assert.equal(extractItem('일호유통에 웹사이트 유지보수 건으로 330만원 세금계산서 끊어 줘', '일호유통'), '웹사이트 유지보수');
    assert.equal(extractItem('세금계산서 1000원 일호유통에 끊자', '일호유통'), null);
    assert.equal(extractItem('일호유통에 330만원 부가세 별도로 세금계산서 끊고 메일 보내 줘', '일호유통'), null);
    assert.equal(extractItem('일호유통 1,000원 품목은 디자인 용역으로 발급해 줘', '일호유통'), '디자인 용역');
    assert.equal(extractItem('컨설팅 용역으로 해 줘', null), '컨설팅 용역');
    assert.equal(extractItem('취소', null), null);
    assert.equal(cleanItem('  <b>x</b>  '), 'b x /b');
    assert.equal(cleanItem('123'), null);
    assert.equal(cleanItem('가'.repeat(150))!.length, 100);
  });
  it('모르는 거래처 이름이 품목으로 들어가지 않는다(세금계산서 문장은 거래처가 하나일 때만)', () => {
    assert.equal(parseRegex('새거래처에 컨설팅 100만원 세금계산서', CPS).item, null);
    assert.equal(parseRegex('일호유통에 컨설팅 100만원 세금계산서', CPS).item, '컨설팅');
  });
});

describe('품목이 없으면 카드 전에 묻는다', () => {
  it('저장 품목이 없는 거래처 → "어떤 품목으로…" → 답 → 카드(추정 아님)', () => {
    const { runs } = make();
    const r1 = say(runs, '일호유통에 1000원 세금계산서 끊어 줘');
    assert.deepEqual(r1, { kind: 'say', text: ASK_ITEM_TEXT('일호유통') });
    assert.equal(runs.pending.asked, 'item');
    assert.equal(answersPending(parseRegex('컨설팅 용역', CPS), runs), true, '모델이 unknown이어도 대화 응대로 보내지 않는다');
    const r2 = say(runs, '컨설팅 용역');
    assert.equal(r2.kind, 'draft');
    if (r2.kind !== 'draft') return;
    assert.deepEqual([r2.run.item, r2.run.itemGuessed, r2.run.amount, r2.run.counterparty.name], ['컨설팅 용역', false, 1000, '일호유통']);
    assert.equal(runs.pending.asked, null);
  });
  it('문장에 품목이 있으면 묻지 않고 그것을 쓴다', () => {
    const { runs } = make();
    const r = say(runs, '일호유통에 컨설팅 1000원 세금계산서');
    assert.equal(r.kind === 'draft' && r.run.item, '컨설팅');
    assert.equal(r.kind === 'draft' && r.run.itemGuessed, false);
  });
  it('저장 품목이 있으면 묻지 않고 그것을 추정 값으로', () => {
    const { runs } = make();
    const r = say(runs, 'A상사에 1000원 세금계산서');
    assert.deepEqual(r.kind === 'draft' && [r.run.item, r.run.itemGuessed], ['경영 컨설팅', true]);
  });
  it('되묻는 동안 받은 값(품목·부가세)을 잇는다: 금액을 묻고 답하면 앞 문장의 품목·부가세 그대로', () => {
    const { runs } = make();
    assert.equal(say(runs, '일호유통에 디자인 부가세 포함 세금계산서').kind, 'say');
    assert.equal(runs.pending.asked, 'amount');
    const r = say(runs, '110만원');
    assert.equal(r.kind, 'draft');
    if (r.kind !== 'draft') return;
    assert.deepEqual([r.run.item, r.run.vat, r.run.total], ['디자인', 'included', 1_100_000]);
  });
  it('모델이 품목 답을 세금계산서로 골라도(거래처·금액 없음) 답으로 이어 간다', () => {
    const { runs } = make();
    say(runs, '일호유통에 1000원 세금계산서');
    const p = { ...parseRegex('컨설팅 용역', CPS), intent: 'invoice' as const };
    const r = interpret('컨설팅 용역', null, 'business', runs, p);
    assert.deepEqual(r.kind === 'draft' && [r.run.counterparty.name, r.run.amount, r.run.item], ['일호유통', 1000, '컨설팅 용역']);
  });

  it('품목을 묻는 중 새 세금계산서 문장이면 새로 시작한다, "취소"는 품목이 아니다', () => {
    const { runs } = make();
    say(runs, '일호유통에 1000원 세금계산서');
    assert.equal(parseRegex('취소', CPS).item, null);
    const r = say(runs, 'A상사에 2000원 세금계산서');
    assert.equal(r.kind === 'draft' && r.run.counterparty.name, 'A상사');
    assert.equal(r.kind === 'draft' && r.run.amount, 2000);
  });
});

describe('카드에서 품목·받는 이메일 고치기, 품목 없이는 준비하지 않는다', () => {
  it('draft.update item·email: 비운 품목·틀린 이메일은 거부, 고치면 추정이 아니다', () => {
    const { runs } = make();
    const d = runs.createDraft(WITH_ITEM, 1000, null);
    assert.equal(d.itemGuessed, true);
    assert.throws(() => runs.updateDraft(d.id, { item: '   ' }), /item_required/);
    assert.throws(() => runs.updateDraft(d.id, { email: 'x@' }), /bad_email/);
    const u = runs.updateDraft(d.id, { item: ' 디자인  용역 ', email: '' });
    assert.deepEqual([u.item, u.itemGuessed, u.email.value], ['디자인 용역', false, '']);
  });
  it('품목이 빈 초안은 [홈택스에서 준비]를 받지 않고(item_required) 카드가 그대로 남는다. 넣으면 엔진에 그 품목으로 시작', async () => {
    const { host, runs } = make();
    const d = runs.createDraft(NO_ITEM, 1000, null);
    assert.equal(d.item, '');
    await assert.rejects(runs.prepare(d.id), /item_required/);
    assert.equal(runs.get(d.id)!.status, 'draft');
    assert.equal(host.starts.length, 0);
    runs.updateDraft(d.id, { item: '컨설팅' });
    await runs.prepare(d.id);
    assert.equal(host.starts[0]!.itemName, '컨설팅');
  });
  it('그래도 엔진이 item_missing으로 멈추면 할 일을 말한다', () => {
    assert.match(NOTE.item_missing!, /품목/);
    assert.match(NOTE.item_missing!, /거래처 화면에서 \[저장 품목\]을 넣거나/);
    assert.match(NOTE.item_missing!, /다시 하면 품목을 물어볼게요/);
  });
});

describe('카드에서 거래처 바꾸기(F-14)', () => {
  it('장부의 거래처로 바뀌고 받는 이메일은 새 거래처 것, 저장 품목에서 온 품목은 새 거래처의 저장 품목', () => {
    const { runs } = make();
    const d = runs.createDraft(WITH_ITEM, 1000, null);
    const u = runs.updateDraft(d.id, { counterpartyId: 'cp-z' });
    assert.deepEqual([u.counterparty.name, u.counterparty.bizNo, u.email.value, u.item, u.itemGuessed, u.amount], ['B상사', '1068114580', 'b@b.example', '사무용품', true, 1000]);
  });
  it('대화·카드에서 받은 품목은 그대로, 새 거래처에 저장 품목이 없으면 비고 [홈택스에서 준비]는 item_required', async () => {
    const { runs } = make();
    const d = runs.createDraft(WITH_ITEM, 1000, null, '디자인');
    assert.equal(runs.updateDraft(d.id, { counterpartyId: 'cp-z' }).item, '디자인');
    const e = runs.createDraft(WITH_ITEM, 1000, null);
    assert.equal(runs.updateDraft(e.id, { counterpartyId: 'cp-x' }).item, '');
    await assert.rejects(runs.prepare(e.id), /item_required/);
  });
  it('장부에 없는 id는 no_counterparty, 초안이 아니면 not_draft', async () => {
    const { runs } = make();
    const d = runs.createDraft(WITH_ITEM, 1000, null);
    assert.throws(() => runs.updateDraft(d.id, { counterpartyId: 'cp-nope' }), /no_counterparty/);
    assert.equal(runs.get(d.id)!.counterparty.name, 'A상사');
    await runs.prepare(d.id);
    assert.throws(() => runs.updateDraft(d.id, { counterpartyId: 'cp-z' }), /not_draft/);
  });
});

describe('등록증 종목 → 저장 품목 후보(F-15)', () => {
  it('첫 종목만, 공백 정리, 저장 품목 상한(40)', () => {
    assert.equal(certItem('소프트웨어 개발, 컨설팅'), '소프트웨어 개발');
    assert.equal(certItem('  경영   컨설팅 '), '경영 컨설팅');
    assert.equal(certItem('도매/소매'), '도매');
    assert.equal(certItem(''), '');
    assert.equal(certItem('가'.repeat(CP_FIELD_MAX.item + 20)).length, CP_FIELD_MAX.item);
  });
});

describe('배선', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  it('처음 쓴 품목은 저장 품목이 없는 거래처에만 준비할 때 남긴다(있으면 그대로)', () => {
    const src = read('apps/desktop/src/shell-app.ts');
    assert.match(src, /const r = await runs\.prepare\(id\);\s*await keepItem\(id\);/);
    assert.match(src, /if \(!r \|\| r\.itemGuessed \|\| !r\.item\) return;\s*const cp = cps\.find\(\(c\) => c\.id === r\.counterparty\.id\);\s*if \(!cp \|\| cp\.item\) return;/);
    assert.match(src, /await cpBook\.setFirstItem\(cp\.id, r\.item\);/);
    assert.match(src, /item: typeof p\.item === 'string' \? p\.item : undefined,\s*email: typeof p\.email === 'string' \? p\.email : undefined,/);
  });
  it('카드: 품목·이메일을 값으로 보이고(누르면 고침), 품목이 비면 [홈택스에서 준비]가 꺼지고 품목 값이 빈칸 표시다', () => {
    const v = read('apps/desktop/static/shell/shell-views.js');
    assert.match(v, /btn\('홈택스에서 준비', \(\) => act\.prepare\(run\.id\), 'sx-btn-primary', \{ 'data-act': 'prepare', disabled: noItem \}\)/);
    assert.match(v, /valBtn\('품목', `\$\{noItem \? '비어 있음' : run\.item\}`, \(\) => act\.editFields\(run\.id, 'item'\), \{ act: 'fields-edit', cls: noItem \? 'is-missing'/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /putRun\(await call\('draft\.update', \{ id, item: String\(item\), email: String\(email\) \}\)\);/);
  });
  it('카드 거래처 값: 장부(state.cps)에서 고르고 draft.update counterpartyId로 main이 바꾼다', () => {
    const v = read('apps/desktop/static/shell/shell-views.js');
    assert.match(v, /valBtn\('거래처', run\.counterparty\.name, \(\) => act\.editCp\(run\.id\), \{ act: 'draft-cp' \}\)/);
    assert.match(v, /const others = \(act\.counterparties \?\? \[\]\)\.filter\(\(c\) => c\.id !== run\.counterparty\.id\);/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /putRun\(await call\('draft\.update', \{ id, counterpartyId: String\(counterpartyId\) \}\)\);/);
    assert.match(shell, /editingCp: state\.editingCp, counterparties: state\.cps/);
    assert.match(read('apps/desktop/src/shell-app.ts'), /counterpartyId: typeof p\.counterpartyId === 'string' \? p\.counterpartyId : undefined,/);
  });
  it('[등록증으로 채우기]는 비어 있는 저장 품목 칸에만 종목을 채운다', () => {
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /const itemIn = form\.elements\.namedItem\('item'\);\s*const itemFilled = !!r\.item && !!itemIn && !String\(itemIn\.value\)\.trim\(\);\s*if \(itemFilled\) itemIn\.value = r\.item;/);
    assert.doesNotMatch(shell, /form\.elements\.item\b/, 'elements.item은 HTMLFormControlsCollection.item() 메서드다');
  });
});
