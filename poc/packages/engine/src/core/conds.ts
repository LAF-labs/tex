import { normalizeName } from './constants.ts';
import { domValue, inputEntryKey, normalizeFor } from './readback.ts';
import type { PageReader } from './page.ts';
import { compileRe2 } from './re2.ts';
import { resolveTarget } from './resolve.ts';
import { isAbsent, readRef, scalar, type RunScope } from './scope.ts';
import { isSecretEntry, type Cond, type SelectorDict, type Strings } from './types.ts';

export interface CondEnv {
  page: PageReader;
  dict: SelectorDict;
  strings: Strings;
  scope: RunScope;
  pre?: { inputVerified?(name: string): boolean; profileHas?(key: string): boolean; artifact?(name: string): boolean };
}

export type CondResult = { ok: true; value: boolean } | { ok: false; code: string };

const T: CondResult = { ok: true, value: true };
const F: CondResult = { ok: true, value: false };
const bool = (b: boolean): CondResult => (b ? T : F);

/** strings의 정규식 키를 RE2 규칙으로 컴파일한다(V-01). 없거나 컴파일되지 않으면 null. */
export function stringPattern(strings: Strings, key: string): RegExp | null {
  const p = strings[key];
  if (typeof p !== 'string') return null;
  try {
    return compileRe2(p);
  } catch {
    return null;
  }
}

export async function evalCond(c: Cond, env: CondEnv): Promise<CondResult> {
  if ('all' in c) {
    for (const x of c.all) {
      const r = await evalCond(x, env);
      if (!r.ok || !r.value) return r;
    }
    return T;
  }
  if ('any' in c) {
    for (const x of c.any) {
      const r = await evalCond(x, env);
      if (!r.ok || r.value) return r;
    }
    return F;
  }
  if ('not' in c) {
    const r = await evalCond(c.not, env);
    return r.ok ? bool(!r.value) : r;
  }
  if ('exists' in c) {
    if (isSecretEntry(env.dict.entries[c.exists])) return { ok: false, code: 'step.secret_field' };
    const r = await resolveTarget(env.page, env.dict, c.exists);
    if (r.ok) return T;
    return r.code === 'step.selector_miss' && !r.ambiguous ? F : { ok: false, code: r.code };
  }
  if ('textMatches' in c) {
    const { target, patternRef } = c.textMatches;
    if (isSecretEntry(env.dict.entries[target])) return { ok: false, code: 'step.secret_field' };
    const re = stringPattern(env.strings, patternRef);
    if (!re) return { ok: false, code: 'step.cond_unsupported' };
    const r = await resolveTarget(env.page, env.dict, target);
    if (!r.ok) return r.code === 'step.selector_miss' && !r.ambiguous ? F : { ok: false, code: r.code };
    return bool(re.test(normalizeName(await domValue(env.page, env.dict.entries[target]!, r.t.el))));
  }
  if ('varEquals' in c) {
    const v = env.scope.vars.get(c.varEquals.name);
    const want = c.varEquals.value;
    return bool(v !== undefined && (typeof want === 'string' || typeof want === 'number' || typeof want === 'boolean') && v === String(want));
  }
  if ('varSet' in c) return bool(env.scope.vars.has(c.varSet));
  if ('inputPresent' in c) return bool(!isAbsent(readRef(env.scope, `$inputs.${c.inputPresent}`)));
  if ('inputVerified' in c) return env.pre?.inputVerified ? bool(env.pre.inputVerified(c.inputVerified)) : { ok: false, code: 'step.cond_unsupported' };
  if ('profileHas' in c) return env.pre?.profileHas ? bool(env.pre.profileHas(c.profileHas)) : { ok: false, code: 'step.cond_unsupported' };
  if ('artifact' in c) return env.pre?.artifact ? bool(env.pre.artifact(c.artifact)) : { ok: false, code: 'step.cond_unsupported' };
  if ('readbackEquals' in c) {
    const { fieldKey, ref, ifAbsent } = c.readbackEquals;
    const got = env.scope.readback.get(fieldKey);
    const want = readRef(env.scope, ref);
    if (got === undefined) return { ok: false, code: 'step.ref_unresolved' };
    if (isAbsent(want)) return ifAbsent === 'empty' ? bool(got === '') : ifAbsent === 'skip' ? bool(true) : { ok: false, code: 'step.ref_unresolved' };
    const w = scalar(want);
    if (w === null) return { ok: false, code: 'step.ref_unresolved' };
    return bool(normalizeFor(env.dict, fieldKey, w) === got);
  }
  if ('readbackEmpty' in c) {
    const got = env.scope.readback.get(c.readbackEmpty);
    return got === undefined ? { ok: false, code: 'step.ref_unresolved' } : bool(got === '');
  }
  if ('sumEquals' in c) {
    const { parts, total } = c.sumEquals;
    const vals = [...parts, total].map((f) => env.scope.readback.get(f));
    if (vals.some((v) => v === undefined)) return { ok: false, code: 'step.ref_unresolved' };
    if (!vals.every((v) => /^-?\d+$/.test(v!))) return { ok: false, code: 'step.assert_failed' };
    const sum = parts.reduce((a, f) => a + BigInt(env.scope.readback.get(f)!), 0n);
    return bool(sum === BigInt(env.scope.readback.get(total)!));
  }
  if ('fieldsFilled' in c) {
    for (const f of c.fieldsFilled.fields) {
      const k = inputEntryKey(env.dict, f);
      if (!k) return { ok: false, code: 'step.selector_miss' };
      const entry = env.dict.entries[k]!;
      if (isSecretEntry(entry)) return { ok: false, code: 'step.secret_field' };
      const r = await resolveTarget(env.page, env.dict, k);
      if (!r.ok) return { ok: false, code: r.code };
      if (normalizeName(await domValue(env.page, entry, r.t.el)) === '') return F;
    }
    return T;
  }
  return { ok: false, code: 'step.cond_unsupported' };
}
