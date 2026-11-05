// 포털 로그인 아이디(팀장 결정 2026-11-05): 홈택스 아이디 로그인(보안카드 경로)의 아이디는 비밀이 아니라 프로필 정보다.
// 비밀번호·보안카드 값은 금고(vault)만 갖고 DB에는 두지 않는다(D05). 아이디도 로그에 값을 쓰지 않는다(절대 규칙 ⑥).
import type { Db } from './open.ts';

/** 아이디를 둘 수 있는 포털. 정부24는 자동화하지 않으므로 없다 */
export const LOGIN_PORTALS = ['hometax'] as const;
export type LoginPortal = (typeof LOGIN_PORTALS)[number];

export interface PortalLogin {
  profileId: string;
  portal: LoginPortal;
  loginId: string;
  updatedAt: string;
}

export class PortalLoginError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** 앞뒤 공백을 뗀 1~64자, 공백·제어 문자 없음 */
export function normalizeLoginId(raw: string): string {
  const id = raw.trim();
  if (!id || id.length > 64 || /[\s\p{Cc}]/u.test(id)) throw new PortalLoginError('invalid_login_id');
  return id;
}

const isPortal = (p: string): p is LoginPortal => (LOGIN_PORTALS as readonly string[]).includes(p);

export class PortalLoginRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(profileId: string, portal: LoginPortal): string | null {
    const v = this.db.prepare('SELECT login_id FROM portal_logins WHERE profile_id = ? AND portal = ?').pluck().get(profileId, portal) as string | undefined;
    return v ?? null;
  }

  list(profileId: string): PortalLogin[] {
    return (this.db.prepare('SELECT * FROM portal_logins WHERE profile_id = ? ORDER BY portal').all(profileId) as Array<Record<string, unknown>>).map((r) => ({
      profileId: String(r.profile_id),
      portal: r.portal as LoginPortal,
      loginId: String(r.login_id),
      updatedAt: String(r.updated_at),
    }));
  }

  /** 넣거나 바꾼다. 프로필이 없으면 profile_not_found */
  set(profileId: string, portal: string, loginId: string, at: string = new Date().toISOString()): PortalLogin {
    if (!isPortal(portal)) throw new PortalLoginError('invalid_portal');
    const id = normalizeLoginId(loginId);
    if (this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId) === undefined) throw new PortalLoginError('profile_not_found');
    this.db
      .prepare(`INSERT INTO portal_logins (profile_id, portal, login_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, portal) DO UPDATE SET login_id = excluded.login_id, updated_at = excluded.updated_at`)
      .run(profileId, portal, id, at);
    return { profileId, portal, loginId: id, updatedAt: at };
  }

  /** 지웠으면 true */
  remove(profileId: string, portal: LoginPortal): boolean {
    return this.db.prepare('DELETE FROM portal_logins WHERE profile_id = ? AND portal = ?').run(profileId, portal).changes > 0;
  }
}
