import fs from 'node:fs/promises';
import type { Profile as DbProfile } from '@sax/db';
import { parseOnbState, type AppConsentRecord, type OnboardingPorts, type OnbProfile, type OnbState } from './onboarding.ts';

export type EngineRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export const ONB_STORE_METHODS = ['consent.record', 'consent.attach', 'onboarding.load', 'onboarding.save', 'profile.upsert', 'profile.setCertName'] as const;

const PROFILE_KIND = 'business';

export class EngineOnboardingStore {
  private readonly rpc: EngineRpc;
  private profileId: string | null = null;
  constructor(rpc: EngineRpc) {
    this.rpc = rpc;
  }

  async load(): Promise<OnbState | null> {
    const r = (await this.rpc('onboarding.load', { profileKind: PROFILE_KIND })) as { profileId: string | null; state: unknown } | null;
    if (!r) return null;
    if (typeof r.profileId === 'string') this.profileId = r.profileId;
    return parseOnbState(r.state);
  }

  async save(s: OnbState): Promise<void> {
    await this.rpc('onboarding.save', { profileKind: PROFILE_KIND, profileId: this.profileId, step: s.step, state: s });
  }

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

  async saveProfile(p: OnbProfile, certName: string | null = null): Promise<DbProfile> {
    const { certId, ...row } = p;
    let saved = (await this.rpc('profile.upsert', { ...row, corpNo: null })) as DbProfile;
    this.profileId = saved.id;
    await this.rpc('consent.attach', { profileId: saved.id });
    if (row.signMethod !== 'cert') {
      if (saved.certName) saved = (await this.rpc('profile.setCertName', { id: saved.id, name: null })) as DbProfile;
    } else if (certId && certName) saved = (await this.rpc('profile.setCertName', { id: saved.id, name: certName })) as DbProfile;
    return saved;
  }

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

export type OnboardingExternal = Pick<OnboardingPorts, 'recognizeBizCert' | 'checkBizNo' | 'findCerts' | 'consentConfig'> & {
  certName?(certId: string): Promise<string | null>;
};

export function onboardingPorts(external: OnboardingExternal, store: EngineOnboardingStore, afterProfile: () => Promise<void> = async () => {}): OnboardingPorts {
  return {
    recognizeBizCert: () => external.recognizeBizCert(),
    checkBizNo: (bizNo) => external.checkBizNo(bizNo),
    findCerts: () => external.findCerts(),
    consentConfig: () => external.consentConfig(),
    recordConsent: (rec) => store.recordConsent(rec),
    saveProfile: async (p) => {
      const name = p.certId && external.certName ? await external.certName(p.certId).catch(() => null) : null;
      await store.saveProfile(p, name);
      await afterProfile();
    },
    save: (st) => store.save(st),
  };
}
