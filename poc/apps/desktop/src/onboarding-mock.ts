import { dayOffset } from './shell-mock.ts';
import { CONSENT_CONFIG } from './onboarding.ts';
import type { AppConsentRecord, BizFields, ConsentConfig, OnbProfile, OnbState, OnboardingPorts } from './onboarding.ts';

export const MOCK_BIZ_CERT: BizFields = { name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', bizType: '서비스업', bizItem: '경영 컨설팅', address: '서울특별시 가나구 다라로 12, 3층', email: 'office@ganada.example' };
export const MOCK_CP_CERT: BizFields = { name: '견본상사', bizNo: '3148601237', rep: '이견본', bizType: '도매', bizItem: '사무용품', address: '서울특별시 견본구 시험로 34', email: '' };

export const MOCK_CONSENT_CONFIG: ConsentConfig = { ...CONSENT_CONFIG, processorsVersion: 'mock-2026-11-05' };

export interface MockOnboardingOptions {
  saveProfile: (p: OnbProfile) => Promise<void>;
  bizCert?: BizFields | null;
  bizStatus?: 'active' | 'suspended' | 'closed';
}

export class MockOnboardingPorts implements OnboardingPorts {
  readonly consents: AppConsentRecord[] = [];
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
  async certName(certId: string) {
    return ({ 'npki-1': '가나다컴퍼니()0001234567891', 'npki-2': '김가나()0009876543210' } as Record<string, string>)[certId] ?? null;
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
