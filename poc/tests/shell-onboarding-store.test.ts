// 온보딩 저장소 어댑터(onboarding-store.ts): 상태 기계(OnboardingFlow)를 실제 엔진 data-service(#91)·암호화 DB(#53)에 붙여 돌린다. Electron 없이.
// 동의 레코드는 쌓이고(프로필 전 NULL → 프로필에 잇기), 이어 하기는 DB 한 행, 포털 아이디는 profiles.portal_login_id.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { ConsentRepo, openDatabase, type Db, type Profile } from '@sax/db';
import { BizVerifier, DataService } from '@sax/engine';
import { MAIN_ONLY } from '@sax/engine/protocol';
import { Egress } from '@sax/net';
import { MockOnboardingPorts, MOCK_CONSENT_CONFIG } from '../apps/desktop/src/onboarding-mock.ts';
import { EngineOnboardingStore, ONB_STORE_METHODS, onboardingPorts } from '../apps/desktop/src/onboarding-store.ts';
import { CONSENT_NOTICES, OnboardingFlow, type OnbAnswer } from '../apps/desktop/src/onboarding.ts';

const NOW = () => new Date('2026-11-06T01:00:00Z');
const UPTO_DELEGATION: OnbAnswer[] = [
  { step: 'terms', choice: 'agree' },
  { step: 'welcome', choice: 'upload' },
  { step: 'biz-confirm', choice: 'confirm' },
  { step: 'auth', choice: 'card' },
  { step: 'delegation', choice: 'agree' },
];
const TO_SUMMARY: OnbAnswer[] = [
  { step: 'model', choice: 'agree' },
  { step: 'telemetry', choice: 'off' },
  { step: 'tasks', choice: 'submit', tasks: { 'H-03': true, 'H-02': true } },
  { step: 'summary', choice: 'ok' },
];

describe('온보딩 저장소: 엔진 명령으로 DB에', () => {
  let root: string;
  let db: Db;
  let svc: DataService;
  let calls: string[];
  const rpc = async (m: string, p: Record<string, unknown>) => {
    calls.push(m);
    return svc.handle(m, p);
  };
  const flowOn = (store: EngineOnboardingStore) => new OnboardingFlow(onboardingPorts(new MockOnboardingPorts({ saveProfile: async () => {} }), store), null, NOW);
  const walk = async (flow: OnboardingFlow, answers: OnbAnswer[]) => {
    for (const a of answers) await flow.answer(a);
  };

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-onb-store-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
    svc = new DataService(db, new BizVerifier(new Egress()), { vaultDir: path.join(root, 'vault') });
    calls = [];
  });
  afterEach(() => db.close());

  it('부르는 엔진 명령은 main 전용 온보딩 명령과 profile.upsert뿐이다', () => {
    for (const m of ONB_STORE_METHODS) assert.ok(m === 'profile.upsert' || (MAIN_ONLY as readonly string[]).includes(m), m);
  });

  it('끝까지: 동의 5행(약관·위임 2·모델·텔레메트리)이 프로필에 이어지고, 포털 아이디는 프로필 열, 이어 하기는 한 행', async () => {
    const flow = flowOn(new EngineOnboardingStore(rpc));
    await walk(flow, UPTO_DELEGATION);
    const consents = new ConsentRepo(db);
    // 프로필 전: 약관·위임은 profile_id NULL로 쌓인다.
    assert.deepEqual(consents.history(null).map((c) => [c.kind, c.via]), [['terms', 'onboarding'], ['delegation', 'T-06'], ['delegation', 'T-06']]);
    await walk(flow, TO_SUMMARY);
    assert.equal(flow.state.step, 'first');
    const p = ((await svc.handle('db.query.profiles.list', {})) as Profile[]).find((x) => x.kind === 'business')!;
    assert.equal(p.portalLoginId, 'ganada01', '금고 등록 결과의 포털 아이디(비밀 아님)');
    assert.equal(p.signMethod, 'security_card');
    assert.equal(consents.history(null).length, 0, '프로필을 저장하면 앞의 동의가 그 프로필로 이어진다');
    const rows = consents.history(p.id);
    assert.deepEqual(rows.map((c) => [c.kind, c.choice]), [['terms', 'agreed'], ['delegation', 'agreed'], ['delegation', 'agreed'], ['model', 'agreed'], ['telemetry', 'declined']]);
    const model = rows.find((c) => c.kind === 'model')!;
    assert.equal(model.processorsVersion, MOCK_CONSENT_CONFIG.processorsVersion);
    assert.equal(model.noticeVersion, CONSENT_NOTICES.model.version);
    assert.equal(rows.find((c) => c.kind === 'terms')!.noticeKey, CONSENT_NOTICES.terms.key);
    assert.equal(rows.find((c) => c.kind === 'delegation')!.noticeVersion, CONSENT_NOTICES.delegation.version);
    // 이어 하기 행: 마지막 단계와 프로필.
    const st = (await svc.handle('onboarding.load', { profileKind: 'business' })) as { step: string; profileId: string | null };
    assert.equal(st.step, 'first');
    assert.equal(st.profileId, p.id);
    // 값 없음: 동의 행·이어 하기 행 어디에도 비밀이 없다(목업 금고는 값을 돌려주지 않는다).
    assert.ok(!calls.includes('consent.latest') && !calls.some((m) => m.startsWith('secret')));
  });

  it('이어 하기: 껐다 켜면(새 저장소) 멈춘 질문부터, 앞의 동의는 다시 묻지 않는다', async () => {
    const a = flowOn(new EngineOnboardingStore(rpc));
    await walk(a, UPTO_DELEGATION);
    assert.equal(a.state.step, 'model');
    const store = new EngineOnboardingStore(rpc);
    const saved = await store.load();
    assert.equal(saved?.step, 'model');
    assert.equal(saved?.consents.terms?.choice, 'agreed');
    assert.equal(saved?.portalLoginId, 'ganada01', '포털 아이디는 이어 하기에 남아 요약에서 프로필에 쓴다');
    const b = new OnboardingFlow(onboardingPorts(new MockOnboardingPorts({ saveProfile: async () => {} }), store), saved, NOW);
    await walk(b, TO_SUMMARY);
    const p = ((await svc.handle('db.query.profiles.list', {})) as Profile[]).find((x) => x.kind === 'business')!;
    assert.equal(p.portalLoginId, 'ganada01');
    assert.equal(new ConsentRepo(db).history(p.id).filter((c) => c.kind === 'terms').length, 1, '약관은 한 번만');
  });

  it('프로필이 생긴 뒤 이어 하기를 불러오면 그 뒤 동의는 바로 그 프로필로 쌓인다', async () => {
    const a = flowOn(new EngineOnboardingStore(rpc));
    await walk(a, [...UPTO_DELEGATION, ...TO_SUMMARY]);
    const store = new EngineOnboardingStore(rpc);
    await store.load();
    await store.recordConsent({ v: 1, kind: 'telemetry', noticeKey: CONSENT_NOTICES.telemetry.key, noticeVersion: CONSENT_NOTICES.telemetry.version, choice: 'agreed', at: '2026-11-06T02:00:00.000Z', via: 'onboarding' });
    const p = ((await svc.handle('db.query.profiles.list', {})) as Profile[]).find((x) => x.kind === 'business')!;
    assert.equal(new ConsentRepo(db).latest(p.id, 'telemetry')?.choice, 'agreed');
    assert.equal(new ConsentRepo(db).history(null).length, 0);
  });

  it('금고 창을 닫으면 위임 동의는 남지 않는다', async () => {
    const store = new EngineOnboardingStore(rpc);
    const flow = new OnboardingFlow(onboardingPorts(new MockOnboardingPorts({ saveProfile: async () => {}, register: 'cancelled' }), store), null, NOW);
    await walk(flow, UPTO_DELEGATION);
    assert.equal(flow.state.step, 'delegation');
    assert.deepEqual(new ConsentRepo(db).history(null).map((c) => c.kind), ['terms']);
  });

  it('옛 이어 하기 파일(M4-2 목업 JSON)은 한 번 옮기고 지운다. 모양이 틀리면 지우고 처음부터, 없으면 null', async () => {
    const a = flowOn(new EngineOnboardingStore(() => Promise.resolve(null)));
    await walk(a, UPTO_DELEGATION.slice(0, 2));
    const file = path.join(root, `legacy-${randomBytes(3).toString('hex')}.json`);
    await fsp.writeFile(file, JSON.stringify(a.state));
    const store = new EngineOnboardingStore(rpc);
    const moved = await store.importLegacyFile(file);
    assert.equal(moved?.step, a.state.step);
    assert.ok(!fs.existsSync(file));
    assert.equal((await new EngineOnboardingStore(rpc).load())?.step, a.state.step);
    await fsp.writeFile(file, '{"step":"nope"}');
    assert.equal(await store.importLegacyFile(file), null);
    assert.ok(!fs.existsSync(file));
    assert.equal(await store.importLegacyFile(file), null, '파일이 없으면 null');
  });
});
