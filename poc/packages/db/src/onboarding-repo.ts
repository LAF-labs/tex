// 온보딩(08 §4 O-01~O-06, D14 M4-2)의 동의 레코드와 이어 하기 상태. 데스크톱 #69 요청(팀장 승인 2026-11-05).
// 동의 레코드는 지우거나 고치지 않고 쌓는다(마지막 행이 현재 결정). 값·비밀은 없다: 무엇을·어느 판 고지로·언제·어떻게 정했는지만.
// 위임 동의(①)는 금고가 만드는 ConsentRecord(@sax/vault, D05 §9)가 정본이고, 여기에는 그 사실(판·시각)만 같은 필드명으로 남긴다.
import { ValidationError } from './repo.ts';
import type { Db } from './open.ts';

/** 동의 화면 4종(D15 F-06): 이용약관·모델 국외 이전·텔레메트리·위임(금고 등록) */
export const CONSENT_KINDS = ['terms', 'model', 'telemetry', 'delegation'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_VIAS = ['onboarding', 'settings', 'T-06'] as const;
export type ConsentVia = (typeof CONSENT_VIAS)[number];

export interface ConsentInput {
  /** null: 프로필을 만들기 전(온보딩 첫 화면 약관). 프로필이 생기면 attachToProfile로 잇는다 */
  profileId: string | null;
  kind: ConsentKind;
  /** 고지 문구 키. 빼면 `consent.<kind>` */
  noticeKey?: string;
  noticeVersion: string;
  /** 모델 국외 이전만: 그때 보인 처리자 표의 판 */
  processorsVersion?: string;
  choice: 'agreed' | 'declined';
  /** ISO 8601 UTC */
  at: string;
  via: ConsentVia;
  /** 동의한 기기의 서명(Phase 2, `SAX-consent-v1`) */
  deviceSig?: string;
}

export interface Consent extends Required<Omit<ConsentInput, 'processorsVersion' | 'deviceSig'>> {
  seq: number;
  processorsVersion: string | null;
  deviceSig: string | null;
}

type Row = Record<string, unknown>;
const toConsent = (r: Row): Consent => ({
  seq: Number(r.seq),
  profileId: (r.profile_id as string) ?? null,
  kind: r.kind as ConsentKind,
  noticeKey: String(r.notice_key),
  noticeVersion: String(r.notice_version),
  processorsVersion: (r.processors_version as string) ?? null,
  choice: r.choice as Consent['choice'],
  at: String(r.at),
  via: r.via as ConsentVia,
  deviceSig: (r.device_sig as string) ?? null,
});

const need = (ok: boolean, code: string): void => {
  if (!ok) throw new ValidationError(code);
};
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isOne = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

export class ConsentRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(c: ConsentInput): Consent {
    need(isOne(CONSENT_KINDS, c.kind), 'bad_consent_kind');
    need(c.choice === 'agreed' || c.choice === 'declined', 'bad_choice');
    need(isOne(CONSENT_VIAS, c.via), 'bad_via');
    need(TOKEN.test(c.noticeVersion), 'bad_notice_version');
    const noticeKey = c.noticeKey ?? `consent.${c.kind}`;
    need(TOKEN.test(noticeKey), 'bad_notice_key');
    need(c.processorsVersion === undefined || TOKEN.test(c.processorsVersion), 'bad_processors_version');
    need(ISO.test(c.at), 'bad_at');
    need(c.deviceSig === undefined || /^[A-Za-z0-9+/=_-]{1,256}$/.test(c.deviceSig), 'bad_device_sig');
    if (c.profileId !== null) need(!!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(c.profileId), 'profile_not_found');
    const seq = this.db
      .prepare('INSERT INTO consents (profile_id, kind, notice_key, notice_version, processors_version, choice, at, via, device_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.profileId, c.kind, noticeKey, c.noticeVersion, c.processorsVersion ?? null, c.choice, c.at, c.via, c.deviceSig ?? null).lastInsertRowid;
    return toConsent(this.db.prepare('SELECT * FROM consents WHERE seq = ?').get(seq) as Row);
  }

  /** 현재 결정(그 종류의 마지막 행). 없으면 null */
  latest(profileId: string | null, kind: ConsentKind): Consent | null {
    const r = this.db.prepare('SELECT * FROM consents WHERE profile_id IS ? AND kind = ? ORDER BY seq DESC LIMIT 1').get(profileId, kind);
    return r ? toConsent(r as Row) : null;
  }

  history(profileId: string | null): Consent[] {
    return this.db.prepare('SELECT * FROM consents WHERE profile_id IS ? ORDER BY seq').all(profileId).map((r) => toConsent(r as Row));
  }

  /** 프로필을 만들기 전에 남긴 동의(profile_id NULL)를 그 프로필에 잇는다. 이은 행 수 */
  attachToProfile(profileId: string): number {
    need(!!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId), 'profile_not_found');
    return this.db.prepare('UPDATE consents SET profile_id = ? WHERE profile_id IS NULL').run(profileId).changes;
  }
}

export interface OnboardingState {
  profileKind: 'business' | 'personal';
  profileId: string | null;
  /** 멈춘 질문(데스크톱 ONB_STEPS 이름, 예: 'biz-confirm'). 뜻은 데스크톱이 갖는다 */
  step: string;
  /** 데스크톱 OnbState 그대로(비밀 없음). DB는 모양을 해석하지 않는다 */
  state: unknown;
  updatedAt: string;
}

const MAX_STATE_BYTES = 64 * 1024;

/** 이어 하기: 앱을 껐다 켜면 멈춘 질문부터(08 §4). 프로필 종류마다 한 행 */
export class OnboardingRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  load(profileKind: OnboardingState['profileKind'] = 'business'): OnboardingState | null {
    const r = this.db.prepare('SELECT * FROM onboarding_state WHERE profile_kind = ?').get(profileKind) as Row | undefined;
    if (!r) return null;
    return { profileKind, profileId: (r.profile_id as string) ?? null, step: String(r.step), state: JSON.parse(String(r.state_json)) as unknown, updatedAt: String(r.updated_at) };
  }

  save(s: { profileKind?: OnboardingState['profileKind']; profileId?: string | null; step: string; state: unknown }, at: string = new Date().toISOString()): OnboardingState {
    const kind = s.profileKind ?? 'business';
    need(kind === 'business' || kind === 'personal', 'bad_profile_kind');
    need(/^[a-z0-9-]{1,32}$/.test(s.step), 'bad_step');
    need(typeof s.state === 'object' && s.state !== null && !Array.isArray(s.state), 'bad_state');
    const json = JSON.stringify(s.state);
    need(Buffer.byteLength(json) <= MAX_STATE_BYTES, 'state_too_large');
    const profileId = s.profileId ?? null;
    if (profileId !== null) need(!!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId), 'profile_not_found');
    this.db
      .prepare(`INSERT INTO onboarding_state (profile_kind, profile_id, step, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_kind) DO UPDATE SET profile_id = COALESCE(excluded.profile_id, onboarding_state.profile_id), step = excluded.step, state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .run(kind, profileId, s.step, json, at);
    return this.load(kind)!;
  }

  /** 온보딩을 끝냈거나 처음부터 다시 할 때 */
  clear(profileKind: OnboardingState['profileKind'] = 'business'): boolean {
    return this.db.prepare('DELETE FROM onboarding_state WHERE profile_kind = ?').run(profileKind).changes > 0;
  }
}
