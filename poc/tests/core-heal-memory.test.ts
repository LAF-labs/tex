// 고친 선택자 기억(core/heal-memory.ts)과 폴백 0단계(core/fallback.ts): 고친 후보가 통과하면 남기고, 다음 실행은 처음부터 그 후보로 맞히며,
// 틀리면 바로 버린다. 커밋·비밀 칸·게이트 뒤 항목은 남기지 않고, 이름 규칙을 바꾼 고침도 남기지 않는다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entryFingerprint, FallbackChain, HEAL_TTL_MS, HealMemory, healableKeys, MemoryHealStore, type PlaybookIR, type SelectorDict, type SelectorEntry, type Step } from '@sax/engine/core';
import { FakeClock, FakePage, type FEl } from './core-page-fakes.ts';

const entry = (o: Partial<SelectorEntry> & Pick<SelectorEntry, 'candidates' | 'role' | 'namePattern'>): SelectorEntry => ({ frame: 'main', landmark: 'root', commits: false, lastVerified: '2026-11-16', ...o });

const dict = (): SelectorDict => ({
  entries: {
    root: entry({ candidates: [{ kind: 'css', value: 'body' }], role: 'document', namePattern: '^.*$', landmark: 'root' }),
    item: entry({ candidates: [{ kind: 'css', value: '#oldItem' }, { kind: 'role', role: 'textbox', name: '품목' }], role: 'textbox', namePattern: '^품목$' }),
    pw: entry({ candidates: [{ kind: 'css', value: '#oldPw' }, { kind: 'role', role: 'textbox', name: '비밀번호' }], role: 'textbox', namePattern: '^비밀번호$', inputType: 'password' }),
    issue: entry({ candidates: [{ kind: 'css', value: '#oldIssue' }, { kind: 'role', role: 'button', name: '발급하기' }], role: 'button', namePattern: '^발급하기$', commits: true }),
    after: entry({ candidates: [{ kind: 'css', value: '#oldAfter' }, { kind: 'role', role: 'button', name: '닫기' }], role: 'button', namePattern: '^닫기$' }),
  },
} as unknown as SelectorDict);

const steps: Step[] = [
  { id: 's1', type: 'fill', target: 'item', value: 'x' },
  { id: 's2', type: 'fill', target: 'pw', value: 'x' },
  { id: 's3', type: 'gate', card: 'c', authorizes: ['s4'] },
  { id: 's4', type: 'click', target: 'issue' },
  { id: 's5', type: 'click', target: 'after' },
  { id: 's6', type: 'end', status: 'success' },
] as unknown as Step[];
const ir = { ir: 2, id: 't', version: '1', steps } as unknown as PlaybookIR;

// 화면: 품목 칸 id가 바뀌었다(#oldItem → #newItem). 접근성 이름은 그대로.
const els = (): FEl[] => [
  { id: 'body', role: 'document', name: '', css: ['body'] },
  { id: 'it', role: 'textbox', name: '품목', parent: 'body', css: ['#newItem'] },
];

function chain(d: SelectorDict, mem: HealMemory | undefined, seeded?: Map<string, string>, journal: string[] = []) {
  const clock = new FakeClock();
  const page = new FakePage(clock, els());
  return new FallbackChain({ ir, dict: d, page, irreversible: new Set(['s4']), ...(mem ? { memory: mem, seeded: seeded ?? new Map() } : {}), journal: (t) => journal.push(t) });
}

describe('고친 선택자 기억', () => {
  it('기억해도 되는 항목: 첫 게이트 앞 되돌릴 수 있는 스텝의 대상만(비밀번호·커밋·게이트 뒤는 아님)', () => {
    assert.deepEqual([...healableKeys(ir, dict(), new Set(['s4']))], ['item']);
  });

  it('1회차: 다시 찾기로 고친 후보가 스텝을 통과하면 남긴다. 2회차: 시작 때 첫 후보로 둔다(폴백 없이)', async () => {
    const store = new MemoryHealStore();
    const pkg = dict();
    const healable = healableKeys(ir, pkg, new Set(['s4']));
    // 1회차
    const d1 = { ...pkg, entries: { ...pkg.entries } };
    const m1 = new HealMemory({ store, pkg, healable, now: () => 1_000 });
    assert.equal(m1.seed(d1).size, 0);
    const j1: string[] = [];
    const c1 = chain(d1, m1, new Map(), j1);
    assert.deepEqual(await c1.recover('s1', 'step.selector_miss'), { from: 's1' });
    assert.ok(j1.includes('fallback.refind'));
    c1.confirmed('s1');
    assert.deepEqual(store.f?.entries.item?.cand, { kind: 'role', role: 'textbox', name: '품목' });
    assert.equal(store.f?.entries.item?.via, 'refind');
    // 2회차: 같은 저장소
    const d2 = { ...pkg, entries: { ...pkg.entries } };
    const m2 = new HealMemory({ store, pkg, healable, now: () => 2_000 });
    const seeded = m2.seed(d2);
    assert.deepEqual([...seeded.keys()], ['item']);
    assert.deepEqual(d2.entries.item!.candidates[0], { kind: 'role', role: 'textbox', name: '품목' });
    // 원본 패키지 사전은 그대로
    assert.deepEqual(pkg.entries.item!.candidates[0], { kind: 'css', value: '#oldItem' });
    // 남은 후보에 같은 것이 두 번 있지 않다
    assert.equal(d2.entries.item!.candidates.filter((c) => c.kind === 'role').length, 1);
  });

  it('기억한 후보로 실패하면 0단계가 실행 사본에서 빼고 같은 스텝을 패키지 후보로 다시 돈다(모델·판정·재시도 없음). 패키지 후보로 통과하면 저장소에서도 지운다', async () => {
    const store = new MemoryHealStore();
    const pkg = dict();
    const healable = healableKeys(ir, pkg, new Set(['s4']));
    store.write({ v: 1, entries: { item: { fp: entryFingerprint(pkg.entries.item!), cand: { kind: 'css', value: '#gone' }, at: 1_000, via: 'locate' } } });
    const d = { ...pkg, entries: { ...pkg.entries } };
    const m = new HealMemory({ store, pkg, healable, now: () => 2_000 });
    const seeded = m.seed(d);
    assert.equal(d.entries.item!.candidates[0]!.kind, 'css');
    const j: string[] = [];
    const c = chain(d, m, seeded, j);
    assert.equal(c.eligible(steps[0]!, 'step.identity_mismatch'), true);
    assert.equal(c.fastEscalate(steps[0]!, 'step.identity_mismatch'), true, '기억으로 실패하면 재시도를 기다리지 않는다');
    assert.deepEqual(await c.recover('s1', 'step.identity_mismatch'), { from: 's1' });
    assert.deepEqual(j, ['fallback.heal_dropped']);
    assert.deepEqual(d.entries.item!.candidates, pkg.entries.item!.candidates);
    assert.equal(c.fastEscalate(steps[0]!, 'step.identity_mismatch'), false, '버린 뒤에는 재시도를 건너뛰지 않는다');
    // 화면이 늦었을 수도 있어 저장소에서는 아직 지우지 않는다
    assert.ok(store.f?.entries.item);
    c.confirmed('s1');
    assert.equal(store.f?.entries.item, undefined);
    assert.equal(c.tried('s1'), 'retry:heal');
  });

  it('패키지가 그 항목을 바꾸었거나(지문 다름) 기한이 지났으면 쓰지 않는다', () => {
    const pkg = dict();
    const healable = healableKeys(ir, pkg, new Set(['s4']));
    const cand = { kind: 'role' as const, role: 'textbox', name: '품목' };
    const stale = new MemoryHealStore();
    stale.write({ v: 1, entries: { item: { fp: 'other', cand, at: 1_000, via: 'refind' } } });
    assert.equal(new HealMemory({ store: stale, pkg, healable, now: () => 2_000 }).seed({ ...pkg, entries: { ...pkg.entries } }).size, 0);
    const old = new MemoryHealStore();
    old.write({ v: 1, entries: { item: { fp: entryFingerprint(pkg.entries.item!), cand, at: 1_000, via: 'refind' } } });
    assert.equal(new HealMemory({ store: old, pkg, healable, now: () => 1_000 + HEAL_TTL_MS + 1 }).seed({ ...pkg, entries: { ...pkg.entries } }).size, 0);
    assert.equal(new HealMemory({ store: old, pkg, healable, now: () => 1_000 + HEAL_TTL_MS - 1 }).seed({ ...pkg, entries: { ...pkg.entries } }).size, 1);
  });

  it('남기지 않는 것: 기억 못 하는 항목(비밀번호·커밋), 이름 규칙을 바꾼 고침, 패키지 첫 후보와 같은 것. 깨진 저장소는 빈 기억', () => {
    const pkg = dict();
    const healable = healableKeys(ir, pkg, new Set(['s4']));
    const store = new MemoryHealStore();
    const m = new HealMemory({ store, pkg, healable });
    const role = { kind: 'role' as const, role: 'textbox', name: '비밀번호' };
    assert.equal(m.remember('pw', { ...pkg.entries.pw!, candidates: [role] }, 'refind'), false);
    assert.equal(m.remember('issue', { ...pkg.entries.issue!, candidates: [{ kind: 'role', role: 'button', name: '발급하기' }] }, 'refind'), false);
    assert.equal(m.remember('item', { ...pkg.entries.item!, namePattern: '^품목명$', candidates: [{ kind: 'css', value: '#x' }] }, 'locate'), false);
    assert.equal(m.remember('item', pkg.entries.item!, 'refind'), false);
    assert.equal(store.f, null);
    const broken = { read: () => { throw new Error('bad json'); }, write: () => {} };
    assert.equal(new HealMemory({ store: broken, pkg, healable }).seed({ ...pkg, entries: { ...pkg.entries } }).size, 0);
  });

  it('기억이 없으면 폴백 사슬은 예전 그대로(0단계 없음)', async () => {
    const pkg = dict();
    const j: string[] = [];
    const c = chain({ ...pkg, entries: { ...pkg.entries } }, undefined, undefined, j);
    // 대상을 못 찾음: 재시도는 한 번만 하고 다시 찾기로(실모델 예행: 재시도 3번 약 90초)
    assert.equal(c.fastEscalate(steps[0]!, 'step.selector_miss', 0), false);
    assert.equal(c.fastEscalate(steps[0]!, 'step.selector_miss', 1), true);
    assert.equal(c.fastEscalate(steps[0]!, 'step.timeout', 1), false);
    assert.deepEqual(await c.recover('s1', 'step.selector_miss'), { from: 's1' });
    assert.deepEqual(j, ['fallback.refind']);
  });
});
