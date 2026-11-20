import { createHash } from 'node:crypto';
import { flatten } from './cfg.ts';
import { candidateText } from './locate.ts';
import { isSecretEntry, type Candidate, type PlaybookIR, type SelectorDict, type SelectorEntry, type Step } from './types.ts';

export const HEAL_TTL_MS = 30 * 24 * 3600_000;
export const HEAL_MAX = 64;

export interface HealRecord {
  fp: string;
  cand: Candidate;
  at: number;
  via: string;
}

export interface HealFile {
  v: 1;
  entries: Record<string, HealRecord>;
}

export interface HealStore {
  read(): HealFile | null;
  write(f: HealFile): void;
}

/** 스텝의 대상 셀렉터 키(fill·click·select·press는 target, wait는 for:selector의 value). */
export function targetOf(s: Step): string | null {
  const x = s as Step & { target?: unknown; for?: unknown; value?: unknown };
  if (typeof x.target === 'string') return x.target;
  if (s.type === 'wait' && x.for === 'selector' && typeof x.value === 'string') return x.value;
  return null;
}

const HEAL_TYPES = new Set(['fill', 'click', 'select', 'wait']);

/**
 * 기억해도 되는 항목: 그 항목을 겨누는 스텝이 모두 첫 게이트 앞의 되돌릴 수 있는 fill·click·select·wait이고,
 * 항목이 커밋·비밀·비밀번호 칸이 아니다. 스텝이 하나도 겨누지 않는 항목(landmark 전용 등)도 아니다.
 */
export function healableKeys(ir: PlaybookIR, dict: SelectorDict, irreversible: ReadonlySet<string>): Set<string> {
  const { info } = flatten(ir.steps);
  const firstGate = Math.min(...[...info.values()].filter((v) => v.step.type === 'gate').map((v) => v.order), Number.POSITIVE_INFINITY);
  const ok = new Set<string>();
  const bad = new Set<string>();
  for (const v of info.values()) {
    const k = targetOf(v.step);
    if (k === null) continue;
    const e = dict.entries[k];
    const fine = !!e && HEAL_TYPES.has(v.step.type) && v.order < firstGate && !irreversible.has(v.step.id) && !e.commits && !isSecretEntry(e);
    (fine ? ok : bad).add(k);
  }
  for (const k of bad) ok.delete(k);
  return ok;
}

/** 패키지 항목 지문: 후보·역할·이름 규칙·frame·landmark·커밋·입력 종류. 패키지가 이 항목을 고치면 달라진다. */
export function entryFingerprint(e: SelectorEntry): string {
  const basis = JSON.stringify([e.candidates, e.role, e.namePattern, e.frame, e.landmark, e.commits, e.inputType ?? null, e.secretKind ?? null, e.expect ?? null]);
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

const sameCand = (a: Candidate, b: Candidate) => candidateText(a) === candidateText(b) && a.kind === b.kind;

export interface HealMemoryDeps {
  store: HealStore;
  pkg: SelectorDict;
  healable: ReadonlySet<string>;
  now?: () => number;
  journal?: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

export class HealMemory {
  private readonly d: HealMemoryDeps;
  private readonly now: () => number;
  private file: HealFile;

  constructor(d: HealMemoryDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    let f: HealFile | null;
    try {
      f = d.store.read();
    } catch {
      f = null;
    }
    this.file = f && f.v === 1 && f.entries && typeof f.entries === 'object' ? f : { v: 1, entries: {} };
  }

  private usable(key: string): HealRecord | null {
    const r = this.file.entries[key];
    const e = this.d.pkg.entries[key];
    if (!r || !e || !this.d.healable.has(key)) return null;
    if (r.fp !== entryFingerprint(e) || this.now() - r.at > HEAL_TTL_MS || this.now() < r.at - 60_000) return null;
    if (!r.cand || !['css', 'role', 'label'].includes(r.cand.kind)) return null;
    return r;
  }

  seed(dict: SelectorDict): Map<string, string> {
    const out = new Map<string, string>();
    for (const key of Object.keys(this.file.entries)) {
      const r = this.usable(key);
      const cur = dict.entries[key];
      if (!r || !cur) continue;
      if (cur.candidates.length && sameCand(cur.candidates[0]!, r.cand)) continue;
      dict.entries[key] = { ...cur, candidates: [r.cand, ...cur.candidates.filter((c) => !sameCand(c, r.cand))] };
      const sel = candidateText(r.cand);
      out.set(key, sel);
      this.d.journal?.('heal.seeded', { key, selector: sel, via: r.via });
    }
    return out;
  }

  remember(key: string, runEntry: SelectorEntry, via: string): boolean {
    const e = this.d.pkg.entries[key];
    const cand = runEntry.candidates[0];
    if (!e || !cand || !this.d.healable.has(key)) return false;
    if (runEntry.namePattern !== e.namePattern || runEntry.role !== e.role || runEntry.frame !== e.frame || runEntry.landmark !== e.landmark) {
      this.d.journal?.('heal.not_kept', { key, why: 'identity_changed' });
      return false;
    }
    if (e.candidates[0] && sameCand(e.candidates[0], cand)) return false;
    this.file.entries[key] = { fp: entryFingerprint(e), cand, at: this.now(), via };
    const keys = Object.keys(this.file.entries);
    if (keys.length > HEAL_MAX) {
      keys.sort((a, b) => this.file.entries[a]!.at - this.file.entries[b]!.at);
      for (const k of keys.slice(0, keys.length - HEAL_MAX)) delete this.file.entries[k];
    }
    this.d.journal?.('heal.learned', { key, selector: candidateText(cand), via });
    this.flush();
    return true;
  }

  forget(key: string, code: string): void {
    if (!this.file.entries[key]) return;
    delete this.file.entries[key];
    this.d.journal?.('heal.forgot', { key, code });
    this.flush();
  }

  snapshot(): HealFile {
    return JSON.parse(JSON.stringify(this.file)) as HealFile;
  }

  private flush(): void {
    try {
      this.d.store.write(this.file);
    } catch {
      this.d.journal?.('heal.store_failed');
    }
  }
}

/** 메모리 저장소(시험·저장소 없는 실행). */
export class MemoryHealStore implements HealStore {
  f: HealFile | null = null;
  read(): HealFile | null {
    return this.f ? (JSON.parse(JSON.stringify(this.f)) as HealFile) : null;
  }
  write(f: HealFile): void {
    this.f = JSON.parse(JSON.stringify(f)) as HealFile;
  }
}
