// H-01 사람 속도 리허설(2026-11-11, reports/H01-rehearsal-2026-11-11.md)에서 찾은 문제의 재현. Electron 없이 판정 모듈과 렌더러 소스로 본다.
// 고쳐야 할 모습을 단언하고 todo로 둔다: 지금은 실패(=문제가 남아 있음)로 todo에 찍히고 스위트를 깨지 않는다. 고치면 통과로 바뀐다(그때 todo를 뗀다).
// 사람 속도에서만 드러나는 흐름(재시작·보관함·온보딩 순서)은 apps/desktop/e2e/shell-rehearsal-e2e.ts가 재현한다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ASK_ITEM_TEXT, interpret, type Counterparty } from '../apps/desktop/src/shell-model.ts';
import { NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, 'apps/desktop', f), 'utf8');

/** 등록증으로 채우거나 직접 넣을 때 [저장 품목]을 비운 거래처(칸이 선택이다). */
const NO_ITEM: Counterparty = { id: 'cp-x', name: '견본상사', bizNo: '3148601237', rep: '이견본', email: '', item: '', status: '계속사업자', checkedOn: '', lastIssuedOn: null };
class FakeHost extends EventEmitter {
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(): Promise<unknown> {
    return {};
  }
}

describe('H-01 리허설: 지금 동작(사실 고정)', () => {
  it('품목 없는 거래처라도 문장의 품목을 카드 품목으로 쓴다(F-01 고친 뒤, 추정 아님)', () => {
    const runs = new ShellRuns(new FakeHost(), { counterparties: () => [NO_ITEM], auth: () => '' });
    const d = interpret('견본상사에 55만원 사무용품 세금계산서', null, 'business', runs);
    assert.equal(d.kind, 'draft');
    assert.ok(d.kind === 'draft' && d.run.item === '사무용품' && !d.run.itemGuessed);
  });

  it('거래처가 하나도 없으면 되묻기 후보가 비어 있다', () => {
    const runs = new ShellRuns(new FakeHost(), { counterparties: () => [], auth: () => '' });
    const r = interpret('세금계산서 발급해 줘', null, 'business', runs);
    assert.ok(r.kind === 'say' && r.text === '어느 거래처에 발급할까요?' && (r.chips ?? []).length === 0);
  });
});

describe('H-01 리허설: 고쳐야 할 모습(todo)', () => {
  it('F-01 품목이 빈 초안은 [홈택스에서 준비] 전에 품목을 고칠 수 있다(카드에 품목 칸 또는 초안 수정)', async () => {
    const runs = new ShellRuns(new FakeHost(), { counterparties: () => [NO_ITEM], auth: () => '' });
    // 품목이 문장에도 저장 품목에도 없으면 카드 전에 묻는다
    const ask = interpret('견본상사에 55만원 세금계산서', null, 'business', runs);
    assert.ok(ask.kind === 'say' && ask.text === ASK_ITEM_TEXT('견본상사'));
    // 그래도 빈 초안이 생기면(직접 만든 초안) 준비를 받지 않고 카드에서 넣는다
    const d = runs.createDraft(NO_ITEM, 550_000, null);
    await assert.rejects(runs.prepare(d.id), /item_required/);
    const u = runs.updateDraft(d.id, { item: '사무용품' });
    assert.equal(u.item, '사무용품');
  });

  it('F-01 item_missing 문구는 다음 할 일(거래처의 저장 품목)을 말한다', () => {
    assert.match(NOTE.item_missing!, /거래처|저장 품목|품목을 (넣|적)/);
  });

  it('F-02 거래처가 없을 때 되묻기는 거래처를 추가하라고 말한다', { todo: 'F-02 거래처 없음' }, () => {
    const runs = new ShellRuns(new FakeHost(), { counterparties: () => [], auth: () => '' });
    const r = interpret('세금계산서 발급해 줘', null, 'business', runs);
    assert.ok(r.kind === 'say');
    assert.match(r.text, /거래처.*(추가|등록)/);
  });

  it('F-07 [홈택스에서 준비] 상한(throttled)·결속(gesture_required) 안내는 같은 "잠시 뒤"가 아니라 이유나 기다릴 시간을 말한다', { todo: 'F-07 준비 상한 문구' }, () => {
    const s = read('static/shell/shell.js');
    assert.ok(!/c === 'gesture_required' \|\| c === 'throttled' \? '잠시 뒤 다시 눌러 주세요\.'/.test(s), 'act.prepare가 결속·상한을 같은 문구로 보인다');
  });

  it('F-08 설치본 화면에 "목업:" 문구가 없다(보관함 [메일로 보내기])', () => {
    for (const f of ['static/shell/shell-views.js', 'static/shell/shell.js']) assert.ok(!/'목업: /.test(read(f)), `${f}에 '목업: ' 문구`);
  });

  it('F-09 login.not_implemented 문구는 발급 인증을 바꾸는 실제 자리(내 사업장)를 가리킨다', { todo: 'F-09 인증 바꾸는 자리' }, () => {
    assert.doesNotMatch(NOTE['login.not_implemented']!, /설정에서/);
  });
});
