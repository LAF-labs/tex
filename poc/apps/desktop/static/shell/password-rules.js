// 비밀번호 칸의 조건 3줄(인계 명세 §3.1, 캔버스 v60 제안 1). 계정 만들기·비밀번호 찾기·설정 > 계정에서 같다.
// 앱은 미리 안내만 한다. 최종 판정은 서버다(services/account/src/password.ts checkPasswordPolicy, ADR-038 (c)).
// 비밀번호는 인자로만 지나가고 어디에도 남기지 않는다.
import { COMMON_10 } from './common-passwords.js';

export const PW_MIN = 10;
export const PW_MAX = 128;
/** 서비스 이름(대소문자 무시). 서버 SERVICE_NAMES와 같다. */
const SERVICE_NAMES = ['sovereignax', 'sovereign', '소버린'];

/** 이메일·서비스 이름 포함 여부. 서버와 같은 규칙: 이메일 전체, 로컬 부분(3자 이상), 서비스 이름. */
export function identityIn(pw, email) {
  const lower = pw.normalize('NFKC').toLowerCase();
  const e = (email ?? '').trim().toLowerCase();
  const local = e.split('@')[0] ?? '';
  if ((e && lower.includes(e)) || (local.length >= 3 && lower.includes(local))) return 'email';
  if (SERVICE_NAMES.some((s) => lower.includes(s))) return 'service';
  return null;
}

/**
 * 조건 3줄의 상태: 'ok'(맞음) | 'wait'(아직) | 'bad'(어긋남).
 * 10자 미만이면 세 줄 모두 'wait'다(목록·이름 검사 결과를 미리 보이지 않는다). 128자를 넘으면 1줄이 'bad'다.
 */
export function pwRules(pw, email) {
  const n = (pw ?? '').normalize('NFKC');
  const len = [...n].length;
  if (len < PW_MIN) return { len: 'wait', common: 'wait', identity: 'wait', identityKind: null, tooLong: false, ok: false };
  const identityKind = identityIn(n, email);
  const common = COMMON_10.has(n.toLowerCase());
  const r = { len: len > PW_MAX ? 'bad' : 'ok', common: common ? 'bad' : 'ok', identity: identityKind ? 'bad' : 'ok', identityKind, tooLong: len > PW_MAX };
  return { ...r, ok: r.len === 'ok' && r.common === 'ok' && r.identity === 'ok' };
}
