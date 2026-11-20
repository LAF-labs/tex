import { COMMON_10 } from './common-passwords.js';

export const PW_MIN = 10;
export const PW_MAX = 128;
const SERVICE_NAMES = ['sovereignax', 'sovereign', '소버린'];

export function identityIn(pw, email) {
  const lower = pw.normalize('NFKC').toLowerCase();
  const e = (email ?? '').trim().toLowerCase();
  const local = e.split('@')[0] ?? '';
  if ((e && lower.includes(e)) || (local.length >= 3 && lower.includes(local))) return 'email';
  if (SERVICE_NAMES.some((s) => lower.includes(s))) return 'service';
  return null;
}

export function pwRules(pw, email) {
  const n = (pw ?? '').normalize('NFKC');
  const len = [...n].length;
  if (len < PW_MIN) return { len: 'wait', common: 'wait', identity: 'wait', identityKind: null, tooLong: false, ok: false };
  const identityKind = identityIn(n, email);
  const common = COMMON_10.has(n.toLowerCase());
  const r = { len: len > PW_MAX ? 'bad' : 'ok', common: common ? 'bad' : 'ok', identity: identityKind ? 'bad' : 'ok', identityKind, tooLong: len > PW_MAX };
  return { ...r, ok: r.len === 'ok' && r.common === 'ok' && r.identity === 'ok' };
}
