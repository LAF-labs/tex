// .sxp 컨테이너 v1(design/schemas/SIGNING.md §6): 레지스트리 `/packages/{id}@{version}.sxp`의 바이트 형식.
// .sxp = utf8(JCS(객체)). 패키지는 {format, kind:"package", manifest, playbook, selectors, strings}(각 값 = 원시 파일 바이트의 표준 base64),
// 핫픽스는 {format, kind:"hotfix", hotfix}. 컨테이너 자체는 서명하지 않는다: 인덱스의 sxpDigest가 바이트를, manifest·hotfix 서명(2-of-3)이 내용을 묶는다.
// 파서는 정규형만 받는다(같은 내용의 다른 바이트 = 다른 sxpDigest가 생기지 않게).
import { canonicalJson, canonicalizable } from './canon.ts';
import type { RawPackage } from './loader.ts';
import type { Hotfix } from './types.ts';

export const SXP_FORMAT = 'sxp/1';
/** 레지스트리 인덱스 항목 size 상한과 같다(16MB). */
export const SXP_MAX_BYTES = 16 * 1024 * 1024;

export type Sxp = { kind: 'package'; raw: RawPackage } | { kind: 'hotfix'; hotfix: Hotfix; bytes: Uint8Array };
export type SxpResult = { ok: true; sxp: Sxp } | { ok: false; code: 'sxp.too_large' | 'sxp.malformed' | 'sxp.not_canonical' | 'sxp.unknown_format' };

const PACKAGE_KEYS = ['format', 'kind', 'manifest', 'playbook', 'selectors', 'strings'];
const HOTFIX_KEYS = ['format', 'kind', 'hotfix'];
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function b64(v: unknown): Buffer | null {
  if (typeof v !== 'string' || !B64.test(v)) return null;
  const b = Buffer.from(v, 'base64');
  return b.toString('base64') === v ? b : null;
}

const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

export function encodeSxp(x: { kind: 'package'; raw: RawPackage } | { kind: 'hotfix'; bytes: Uint8Array }): Buffer {
  const e = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const o =
    x.kind === 'package'
      ? { format: SXP_FORMAT, kind: 'package', manifest: e(x.raw.manifest), playbook: e(x.raw.playbook), selectors: e(x.raw.selectors), strings: e(x.raw.strings) }
      : { format: SXP_FORMAT, kind: 'hotfix', hotfix: e(x.bytes) };
  return Buffer.from(canonicalJson(o), 'utf8');
}

/** 구조만 푼다. 서명·다이제스트·스키마 검사는 loadPackage·checkHotfix가 한다. */
export function decodeSxp(bytes: Uint8Array): SxpResult {
  if (bytes.length > SXP_MAX_BYTES) return { ok: false, code: 'sxp.too_large' };
  let o: unknown;
  const text = Buffer.from(bytes).toString('utf8');
  try {
    o = JSON.parse(text);
  } catch {
    return { ok: false, code: 'sxp.malformed' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, code: 'sxp.malformed' };
  const r = o as Record<string, unknown>;
  if (r.format !== SXP_FORMAT) return { ok: false, code: 'sxp.unknown_format' };
  if (!canonicalizable(r) || canonicalJson(r) !== text) return { ok: false, code: 'sxp.not_canonical' };
  if (r.kind === 'package' && sameKeys(r, PACKAGE_KEYS)) {
    const [manifest, playbook, selectors, strings] = [r.manifest, r.playbook, r.selectors, r.strings].map(b64);
    if (!manifest || !playbook || !selectors || !strings) return { ok: false, code: 'sxp.malformed' };
    return { ok: true, sxp: { kind: 'package', raw: { manifest, playbook, selectors, strings } } };
  }
  if (r.kind === 'hotfix' && sameKeys(r, HOTFIX_KEYS)) {
    const b = b64(r.hotfix);
    if (!b) return { ok: false, code: 'sxp.malformed' };
    try {
      const hotfix = JSON.parse(b.toString('utf8')) as Hotfix;
      if (!hotfix || typeof hotfix !== 'object' || Array.isArray(hotfix)) return { ok: false, code: 'sxp.malformed' };
      return { ok: true, sxp: { kind: 'hotfix', hotfix, bytes: b } };
    } catch {
      return { ok: false, code: 'sxp.malformed' };
    }
  }
  return { ok: false, code: 'sxp.malformed' };
}

/**
 * 인덱스 항목 이름(SIGNING.md §6): 패키지는 manifest의 id·version, 핫픽스는 id = `<appliesTo.id>.hotfix`, version = `<keyEpoch>.<monotonic>.0`
 * (semver 순서 = (keyEpoch, monotonic) 순서, 불변 경로가 핫픽스마다 다름).
 */
export function hotfixIndexName(h: Pick<Hotfix, 'appliesTo' | 'keyEpoch' | 'monotonic'>): { id: string; version: string } {
  return { id: `${h.appliesTo.id}.hotfix`, version: `${h.keyEpoch}.${h.monotonic}.0` };
}
