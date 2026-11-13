// 엔진 data-service의 온보딩 저장소 명령(db #53 ConsentRepo·OnboardingRepo·ProfileRepo.setPortalLoginId, 데스크톱 요청 2026-11-05).
// 모두 main 전용(MAIN_ONLY): 렌더러에 열지 않는다. 저장소 검증 오류는 DataError(code)로 나간다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, syntheticBizNo, type Consent, type Db, type OnboardingState, type Profile } from '@sax/db';
import { BizVerifier, DataService } from '@sax/engine';
import { COMMANDS, MAIN_ONLY } from '@sax/engine/protocol';
import { Egress } from '@sax/net';

const ONBOARDING_CMDS = ['consent.record', 'consent.latest', 'consent.attach', 'onboarding.load', 'onboarding.save', 'onboarding.clear', 'profile.setPortalLoginId', 'profile.setCertName'] as const;
const AT = '2026-11-06T01:00:00.000Z';
const terms = (o: Record<string, unknown> = {}) => ({ profileId: null, kind: 'terms', noticeVersion: '2026-11', choice: 'agreed', at: AT, via: 'onboarding', ...o });

describe('data-service 온보딩 명령', () => {
  let root: string;
  let db: Db;
  let svc: DataService;
  const call = <T>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, p) as Promise<T>;
  const code = async (m: string, p: Record<string, unknown>) => {
    try {
      await call(m, p);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-onb-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
    svc = new DataService(db, new BizVerifier(new Egress()), { vaultDir: path.join(root, 'vault') });
  });
  afterEach(() => db.close());
  const business = () => call<Profile>('profile.upsert', { kind: 'business', displayName: '주식회사 가나다테크', bizNo: syntheticBizNo(7) });

  it('7개 모두 COMMANDS이자 MAIN_ONLY(렌더러에 열지 않음)', () => {
    for (const c of ONBOARDING_CMDS) {
      assert.ok((COMMANDS as readonly string[]).includes(c), c);
      assert.ok((MAIN_ONLY as readonly string[]).includes(c), c);
    }
  });

  it('consent: 프로필 전 약관 → latest(null) → 프로필 생성 뒤 attach → latest(프로필)', async () => {
    const c = await call<Consent>('consent.record', terms());
    assert.equal(c.profileId, null);
    assert.equal(c.noticeKey, 'consent.terms');
    assert.equal((await call<Consent>('consent.latest', { profileId: null, kind: 'terms' }))?.seq, c.seq);
    const p = await business();
    assert.equal(await call<number>('consent.attach', { profileId: p.id }), 1);
    assert.equal(await call('consent.latest', { profileId: null, kind: 'terms' }), null);
    assert.equal((await call<Consent>('consent.latest', { profileId: p.id, kind: 'terms' }))?.seq, c.seq);
    await call('consent.record', terms({ profileId: p.id, choice: 'declined', via: 'settings' }));
    assert.equal((await call<Consent>('consent.latest', { profileId: p.id, kind: 'terms' }))?.choice, 'declined', '마지막 행이 현재 결정');
  });

  it('consent: 빠지거나 문자열이 아닌 필드는 저장소 정규식에 닿기 전에 거부, 저장소 오류는 DataError 코드', async () => {
    assert.equal(await code('consent.record', terms({ noticeVersion: undefined })), 'bad_notice_version', "undefined가 'undefined'로 통과하지 않는다");
    assert.equal(await code('consent.record', terms({ at: 1 })), 'bad_at');
    assert.equal(await code('consent.record', terms({ kind: 'ads' })), 'bad_consent_kind');
    assert.equal(await code('consent.record', terms({ choice: 'maybe' })), 'bad_choice');
    assert.equal(await code('consent.record', terms({ profileId: 'nope' })), 'profile_not_found');
    assert.equal(await code('consent.attach', { profileId: 'nope' }), 'profile_not_found');
    assert.equal(await code('consent.attach', {}), 'profile_not_found');
  });

  it('onboarding: save → load(이어 하기) → profileId는 한번 붙으면 유지 → clear', async () => {
    assert.equal(await call('onboarding.load', {}), null);
    await call('onboarding.save', { step: 'biz-confirm', state: { bizNo: 'x' } });
    const p = await business();
    await call('onboarding.save', { step: 'vault', profileId: p.id, state: { done: ['biz'] } });
    const s = await call<OnboardingState>('onboarding.save', { step: 'consent', state: { done: ['biz', 'vault'] } });
    assert.equal(s.profileId, p.id);
    const l = await call<OnboardingState>('onboarding.load', { profileKind: 'business' });
    assert.deepEqual([l.step, l.state], ['consent', { done: ['biz', 'vault'] }]);
    assert.equal(await call('onboarding.load', { profileKind: 'personal' }), null, '종류마다 한 행');
    assert.equal(await call('onboarding.clear', {}), true);
    assert.equal(await call('onboarding.clear', {}), false);
  });

  it('onboarding: 종류·단계·상태 검사', async () => {
    assert.equal(await code('onboarding.load', { profileKind: 'corp' }), 'bad_profile_kind');
    assert.equal(await code('onboarding.clear', { profileKind: 'corp' }), 'bad_profile_kind');
    assert.equal(await code('onboarding.save', { state: {} }), 'bad_step');
    assert.equal(await code('onboarding.save', { step: 'Bad Step', state: {} }), 'bad_step');
    assert.equal(await code('onboarding.save', { step: 'a', state: [] }), 'bad_state');
    assert.equal(await code('onboarding.save', { step: 'a', state: {}, profileId: 'nope' }), 'profile_not_found');
  });

  it('profile.setPortalLoginId: 정규화(앞뒤 공백), null로 지움, 잘못된 ID·없는 프로필', async () => {
    const p = await business();
    assert.equal((await call<Profile>('profile.setPortalLoginId', { id: p.id, loginId: '  ganada01 ' })).portalLoginId, 'ganada01');
    assert.equal((await call<Profile>('profile.setPortalLoginId', { id: p.id, loginId: null })).portalLoginId, null);
    assert.equal(await code('profile.setPortalLoginId', { id: p.id, loginId: 'a b' }), 'bad_login_id');
    assert.equal(await code('profile.setPortalLoginId', { id: p.id, loginId: 12 }), 'bad_login_id');
    assert.equal(await code('profile.setPortalLoginId', { id: p.id }), 'bad_login_id', '빠진 loginId는 지움이 아니다');
    assert.equal(await code('profile.setPortalLoginId', { id: 'nope', loginId: 'x' }), 'profile_not_found');
    // [홈택스 인증서]에서 고른 인증서 이름(CN, 공개 정보, B4): 공백 접기, 지우기는 null, 문자열 아닌 값 거부
    assert.equal((await call<Profile>('profile.setCertName', { id: p.id, name: ' 가나다컴퍼니()0001234567891 ' })).certName, '가나다컴퍼니()0001234567891');
    assert.equal((await call<Profile>('profile.setCertName', { id: p.id, name: null })).certName, null);
    assert.equal(await code('profile.setCertName', { id: p.id, name: 3 }), 'bad_cert_name');
    assert.equal(await code('profile.setCertName', { id: 'nope', name: 'x' }), 'profile_not_found');
  });
});
