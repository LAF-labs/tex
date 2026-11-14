// 온보딩 저장소 어댑터(08 §4, D14 M4-2 후속). 동의 기록·이어 하기 상태·포털 아이디를 엔진 main 전용 명령(#91)으로 DB(#53)에 남긴다.
// - consent.record·consent.attach: 동의 레코드(ConsentRepo). 프로필을 만들기 전 동의는 profileId null로 쌓고, 프로필을 저장하면 그 프로필에 잇는다.
// - onboarding.load·save: 이어 하기(OnboardingRepo, 사업자 한 행). 앱을 껐다 켜면 멈춘 질문부터.
// - profile.upsert·profile.setPortalLoginId·profile.setCertName: 마칠 때 프로필, 금고 등록 결과의 포털 아이디(비밀 아님, #42),
//   [홈택스 인증서]에서 고른 인증서 이름(CN, 공개 정보. H-01 2.3.0이 이 이름으로 인증서 창의 행을 고른다).
// 비밀은 없다(금고 창 값은 금고로만 간다). 렌더러는 이 명령을 부를 수 없다(MAIN_ONLY, 셸 처리기는 OnboardingFlow만 부른다).
import fs from 'node:fs/promises';
import type { Profile as DbProfile } from '@sax/db';
import { parseOnbState, type AppConsentRecord, type OnboardingPorts, type OnbProfile, type OnbState, type VaultConsentRecord } from './onboarding.ts';

export type EngineRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** 이 어댑터가 부르는 엔진 명령 전부(시험이 MAIN_ONLY와 맞춰 본다). */
export const ONB_STORE_METHODS = ['consent.record', 'consent.attach', 'onboarding.load', 'onboarding.save', 'profile.upsert', 'profile.setPortalLoginId', 'profile.setCertName'] as const;

const PROFILE_KIND = 'business';

export class EngineOnboardingStore {
  private readonly rpc: EngineRpc;
  /** 온보딩이 만든(또는 이어 하기 행에 적힌) 사업자 프로필. 그 전에는 null(동의는 profile_id NULL로 쌓인다). */
  private profileId: string | null = null;
  constructor(rpc: EngineRpc) {
    this.rpc = rpc;
  }

  /** 이어 하기 상태. 없거나 모양이 틀리면 null(처음부터). */
  async load(): Promise<OnbState | null> {
    const r = (await this.rpc('onboarding.load', { profileKind: PROFILE_KIND })) as { profileId: string | null; state: unknown } | null;
    if (!r) return null;
    if (typeof r.profileId === 'string') this.profileId = r.profileId;
    return parseOnbState(r.state);
  }

  async save(s: OnbState): Promise<void> {
    await this.rpc('onboarding.save', { profileKind: PROFILE_KIND, profileId: this.profileId, step: s.step, state: s });
  }

  /** 약관·모델 국외 이전·텔레메트리(앱이 보인 고지). 지우거나 고치지 않고 쌓는다(마지막 행이 현재 결정). */
  async recordConsent(rec: AppConsentRecord): Promise<void> {
    await this.rpc('consent.record', {
      profileId: this.profileId,
      kind: rec.kind,
      noticeKey: rec.noticeKey,
      noticeVersion: rec.noticeVersion,
      ...(rec.processorsVersion ? { processorsVersion: rec.processorsVersion } : {}),
      choice: rec.choice,
      at: rec.at,
      via: rec.via,
    });
  }

  /**
   * ① 위임: 정본은 금고가 저장 때 만든 ConsentRecord(D05 §9)다. 여기에는 그 사실(판·시각, via T-06)만 같은 필드명으로 남긴다.
   * 결속마다 한 행(아이디·비밀번호, 보안카드). 값·칸 수는 남기지 않는다.
   */
  async recordDelegation(records: VaultConsentRecord[]): Promise<void> {
    for (const c of records) await this.rpc('consent.record', { profileId: this.profileId, kind: 'delegation', noticeVersion: c.noticeVersion, choice: 'agreed', at: c.at, via: 'T-06' });
  }

  /**
   * 마칠 때 사업자 프로필 저장 → 프로필 전에 쌓은 동의를 잇고 → 포털 아이디(있으면)를 쓰고 → 인증서 이름을 맞춘다.
   * certName: 공동인증서를 골랐으면 그 CN(못 찾으면 그대로 둔다: 첫 발급에서 사람이 한 번 고르면 실행이 저장한다), 다른 인증이면 지운다.
   */
  async saveProfile(p: OnbProfile, certName: string | null = null): Promise<DbProfile> {
    const { portalLoginId, certId, ...row } = p;
    let saved = (await this.rpc('profile.upsert', { ...row, corpNo: null })) as DbProfile;
    this.profileId = saved.id;
    await this.rpc('consent.attach', { profileId: saved.id });
    if (portalLoginId) saved = (await this.rpc('profile.setPortalLoginId', { id: saved.id, loginId: portalLoginId })) as DbProfile;
    if (row.signMethod !== 'cert') {
      if (saved.certName) saved = (await this.rpc('profile.setCertName', { id: saved.id, name: null })) as DbProfile;
    } else if (certId && certName) saved = (await this.rpc('profile.setCertName', { id: saved.id, name: certName })) as DbProfile;
    return saved;
  }

  /**
   * 옛 이어 하기 파일(앱 폴더 userData/onboarding-state.json, M4-2 목업 때)을 한 번 옮긴다. DB에 행이 있으면 건드리지 않는다.
   * 옮긴 뒤 파일을 지운다. 옛 목업은 동의 레코드를 남기지 않았으므로 동의 행은 채우지 않는다(상태의 동의 표시만 이어진다).
   */
  async importLegacyFile(file: string): Promise<OnbState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
    let s: OnbState | null;
    try {
      s = parseOnbState(JSON.parse(raw));
    } catch {
      s = null;
    }
    if (s) await this.save(s);
    await fs.rm(file, { force: true });
    return s;
  }
}

/** 저장소 밖의 일(등록증 읽기·진위확인·NPKI·금고 등록 창·처리자 표). 지금은 목업 어댑터, 실제 어댑터가 오면 그것으로. */
export type OnboardingExternal = Pick<OnboardingPorts, 'recognizeBizCert' | 'checkBizNo' | 'findCerts' | 'registerSecrets' | 'consentConfig'> & {
  /** 고른 인증서 id → CN(main 안에서만). 모르면 null. */
  certName?(certId: string): Promise<string | null>;
};

/** 셸이 OnboardingFlow에 넘기는 포트: 바깥 일은 external, 저장은 store. 금고 등록이 끝나면 위임 사실을 동의 기록에 남긴다. */
export function onboardingPorts(external: OnboardingExternal, store: EngineOnboardingStore, afterProfile: () => Promise<void> = async () => {}): OnboardingPorts {
  return {
    recognizeBizCert: () => external.recognizeBizCert(),
    checkBizNo: (bizNo) => external.checkBizNo(bizNo),
    findCerts: () => external.findCerts(),
    consentConfig: () => external.consentConfig(),
    registerSecrets: async (binds) => {
      const r = await external.registerSecrets(binds);
      if (r.ok) await store.recordDelegation(r.consents);
      return r;
    },
    recordConsent: (rec) => store.recordConsent(rec),
    saveProfile: async (p) => {
      const name = p.certId && external.certName ? await external.certName(p.certId).catch(() => null) : null;
      await store.saveProfile(p, name);
      await afterProfile();
    },
    save: (st) => store.save(st),
  };
}
