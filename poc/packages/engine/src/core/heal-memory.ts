// 고친 선택자 기억(발급 사다리 0원 칸, 2026-11-16 대표 지시 "가장 싸고 빠른 길부터"): 폴백 사슬이 이번 실행에서 고친 선택자
// (패키지 role·label 후보로 다시 찾기, AI 위치 찾기)가 그 스텝을 실제로 통과시키면 PC에 남겨 둔다. 다음 실행은 시작할 때 그 선택자를
// 실행 사본 사전의 그 항목 첫 후보로 둬서, 같은 화면 변화에 재시도·다시 찾기·모델 호출 없이(0원, 지연 없음) 바로 맞힌다.
// 지키는 것:
// - 서명 패키지 원본은 그대로다. 실행 사본 사전의 후보 순서만 바꾼다. 역할·이름 규칙(namePattern)·frame·landmark는 패키지 값 그대로라
//   R-A1 동일성 검사·유일 일치·커밋 충돌 검사가 매번 그대로 돈다. 이름 규칙을 바꾼 고침(identity_confirmed)은 남기지 않는다.
// - 첫 게이트 앞의 되돌릴 수 있는 스텝만 겨누는 항목만(healableKeys). 커밋·비밀·비밀번호 칸, 비가역 스텝·게이트 뒤 스텝이 겨누는 항목은 아니다.
// - 패키지가 그 항목을 바꾸면(후보·역할·이름 규칙 지문이 달라지면) 기억은 쓰지 않는다. 기억으로 실패하면 바로 버린다(fallback.ts heal 단계).
// - 오래된 기억(HEAL_TTL_MS)은 쓰지 않는다. 패키지당 HEAL_MAX개.
// - 값은 남기지 않는다: 선택자 글(코드 이름·DOM id·접근성 이름)뿐이다(locate.found 저널 줄과 같은 수준).
import { createHash } from 'node:crypto';
import { flatten } from './cfg.ts';
import { candidateText } from './locate.ts';
import { isSecretEntry, type Candidate, type PlaybookIR, type SelectorDict, type SelectorEntry, type Step } from './types.ts';

export const HEAL_TTL_MS = 30 * 24 * 3600_000;
export const HEAL_MAX = 64;

export interface HealRecord {
  /** 패키지 항목 지문(entryFingerprint). 다르면 쓰지 않는다. */
  fp: string;
  cand: Candidate;
  /** 배운 시각(ms) */
  at: number;
  /** 어느 폴백 단계가 찾았는지(refind·locate) */
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
  /** 서명 패키지 사전(원본, 실행 사본 아님) */
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

  /** 쓸 수 있는 기억(지문 같음·기한 안·기억해도 되는 항목)의 후보. */
  private usable(key: string): HealRecord | null {
    const r = this.file.entries[key];
    const e = this.d.pkg.entries[key];
    if (!r || !e || !this.d.healable.has(key)) return null;
    if (r.fp !== entryFingerprint(e) || this.now() - r.at > HEAL_TTL_MS || this.now() < r.at - 60_000) return null;
    if (!r.cand || !['css', 'role', 'label'].includes(r.cand.kind)) return null;
    return r;
  }

  /** 실행 시작: 기억한 후보를 실행 사본 사전의 그 항목 맨 앞에 둔다. 둔 항목 → 선택자 글. */
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

  /**
   * 폴백이 고친 후보가 그 스텝을 통과시켰다: 기억한다. 실행 사본 항목의 이름 규칙·역할이 패키지와 다르면(이름 확인 고침) 남기지 않는다.
   * 패키지 첫 후보와 같으면(재시도로 그냥 된 것) 남길 것이 없다.
   */
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

  /** 기억한 후보로 실패했다: 버린다. */
  forget(key: string, code: string): void {
    if (!this.file.entries[key]) return;
    delete this.file.entries[key];
    this.d.journal?.('heal.forgot', { key, code });
    this.flush();
  }

  /** 시험·진단용 */
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
