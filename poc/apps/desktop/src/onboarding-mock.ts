// 온보딩 목업 어댑터(M4-2). 셸은 바깥 일만 이것으로 한다(onboarding-store.ts onboardingPorts). 실제 어댑터가 붙을 자리:
// - recognizeBizCert: 제품은 bizcert-read.ts(M4-3, docparse 샌드박스, ADR-014), 목업은 시연·e2e만 · checkBizNo: 진위확인(packages/net egress, ADR-029 서버 경유, #65)
// - findCerts: 제품은 이미 실제 길(금고 npki.list #93 → docparse 샌드박스 certInfo, npki-certs.ts). 목업 목록은 시연·e2e만 · registerSecrets: 금고 T-06 등록 창(금고 프로토콜 v1 secret.store, #42)
// - consentConfig: 설정 데이터(모델 상류 공급사 표)
// recordConsent·saveProfile·save(저장)는 셸에서 쓰지 않는다. 엔진 명령으로 DB에 남긴다(onboarding-store.ts). 여기 것은 상태 기계 시험용이다.
import { dayOffset } from './shell-mock.ts';
import { CONSENT_CONFIG } from './onboarding.ts';
import type { AppConsentRecord, BizFields, ConsentConfig, OnbProfile, OnbState, OnboardingPorts, StoreBindRequest, VaultConsentRecord } from './onboarding.ts';

/** 시연 등록증(fixture 가짜 홈택스의 공급자와 같은 값이어야 발급 시연이 이어진다, fixture-mode DEMO_PROFILE). */
export const MOCK_BIZ_CERT: BizFields = { name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', bizType: '서비스업', bizItem: '경영 컨설팅', address: '서울특별시 가나구 다라로 12, 3층', email: 'office@ganada.example' };
/** 시연 거래처 등록증(거래처 [등록증으로 채우기], fixture). 번호는 검증 숫자가 맞는 합성 값이다. */
export const MOCK_CP_CERT: BizFields = { name: '견본상사', bizNo: '3148601237', rep: '이견본', bizType: '도매', bizItem: '사무용품', address: '서울특별시 견본구 시험로 34', email: '' };

/**
 * ② 처리자 표의 설정 데이터(목업). 실제로는 앱 설정(서명된 운영 설정)에서 받는다. 모델 상류가 OpenRouter라 공급사 목록이 바뀔 수 있어
 * 렌더러·상태 기계에 고정하지 않는다(팀장 조건 (c)).
 */
export const MOCK_CONSENT_CONFIG: ConsentConfig = { ...CONSENT_CONFIG, processorsVersion: 'mock-2026-11-05' };

export interface MockOnboardingOptions {
  saveProfile: (p: OnbProfile) => Promise<void>;
  /** 등록증 읽기 결과(시험이 바꾼다). null이면 못 읽음. */
  bizCert?: BizFields | null;
  /** 진위확인 결과(시험이 바꾼다). */
  bizStatus?: 'active' | 'suspended' | 'closed';
  /** 금고 등록 창 결과(시험이 바꾼다). */
  register?: 'ok' | 'cancelled';
}

export class MockOnboardingPorts implements OnboardingPorts {
  readonly consents: AppConsentRecord[] = [];
  readonly binds: StoreBindRequest[][] = [];
  saved: OnbState | null = null;
  private readonly o: MockOnboardingOptions;
  constructor(o: MockOnboardingOptions) {
    this.o = o;
  }
  async recognizeBizCert() {
    return this.o.bizCert === undefined ? { ...MOCK_BIZ_CERT } : this.o.bizCert;
  }
  async checkBizNo(_bizNo: string) {
    const st = this.o.bizStatus ?? 'active';
    const label = { active: '계속사업자 · 일반과세자', suspended: '휴업자', closed: '폐업자' }[st];
    return { status: st, label, taxType: st === 'active' ? '일반과세자' : null, source: '국세청 조회' as const };
  }
  async findCerts() {
    return [
      { id: 'npki-1', owner: '가나다컴퍼니', usage: '사업자 범용', expiresOn: dayOffset(240), usable: true },
      { id: 'npki-2', owner: '김가나', usage: '개인 은행·보험용', expiresOn: dayOffset(12), usable: true },
    ];
  }
  async registerSecrets(binds: StoreBindRequest[]) {
    this.binds.push(binds);
    if (this.o.register === 'cancelled') return { ok: false as const, reason: 'cancelled' };
    const at = new Date().toISOString();
    const consents: VaultConsentRecord[] = binds.map((b) => ({ v: 1, kind: b.kind, scope: b.scope, items: b.kind === 'security_card' ? 30 : 1, tier: 'memory', helloCopy: false, strict: false, noticeVersion: b.notice.version, at, via: 'T-06' }));
    return { ok: true as const, consents, portalLoginId: 'ganada01' };
  }
  async consentConfig() {
    return structuredClone(MOCK_CONSENT_CONFIG);
  }
  async recordConsent(rec: AppConsentRecord) {
    this.consents.push(rec);
  }
  async saveProfile(p: OnbProfile) {
    await this.o.saveProfile(p);
  }
  async save(s: OnbState) {
    this.saved = s;
  }
}
