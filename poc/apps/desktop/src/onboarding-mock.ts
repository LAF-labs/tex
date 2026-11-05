// 온보딩 목업 어댑터(M4-2). 실제 어댑터가 붙을 자리:
// - recognizeBizCert: M4-3 등록증 OCR(docparse 샌드박스, ADR-014) · checkBizNo: 진위확인(packages/net egress, ADR-029 서버 경유)
// - findCerts: NPKI 탐지(파일 메타만) · registerSecrets: 금고 T-06 등록 창(금고 프로토콜 v1 secret.store, #42)
// - recordConsent: 동의 레코드 저장(DB) · consentConfig: 설정 데이터(모델 상류 공급사 표) · save: 이어 하기(DB)
// saveProfile만 실제 길(엔진 profile.upsert)을 부르는 쪽이 넘긴다.
import { dayOffset } from './shell-mock.ts';
import type { AppConsentRecord, BizFields, ConsentConfig, OnbProfile, OnbState, OnboardingPorts, StoreBindRequest, VaultConsentRecord } from './onboarding.ts';

/** 시연 등록증(fixture 가짜 홈택스의 공급자와 같은 값이어야 발급 시연이 이어진다, fixture-mode DEMO_PROFILE). */
export const MOCK_BIZ_CERT: BizFields = { name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', bizType: '서비스업', bizItem: '경영 컨설팅', address: '서울특별시 가나구 다라로 12, 3층', email: 'office@ganada.example' };

/**
 * ② 처리자 표의 설정 데이터(목업). 실제로는 앱 설정(서명된 운영 설정)에서 받는다. 모델 상류가 OpenRouter라 공급사 목록이 바뀔 수 있어
 * 렌더러·상태 기계에 고정하지 않는다(팀장 조건 (c)).
 */
export const MOCK_CONSENT_CONFIG: ConsentConfig = {
  processorsVersion: 'mock-2026-11-05',
  processors: [
    { name: 'OpenRouter', role: '모델 중계', country: '미국', retention: '보관하지 않음(설정 확인 전 30일)' },
    { name: '모델 공급사(라우팅 대상)', role: '문장 해석', country: '미국·EU', retention: 'ZDR 승인 전 30일' },
  ],
};

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
      { id: 'npki-1', owner: '가나다컴퍼니', usage: '사업자 범용', expiresOn: dayOffset(240) },
      { id: 'npki-2', owner: '김가나', usage: '개인 은행·보험용', expiresOn: dayOffset(12) },
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
