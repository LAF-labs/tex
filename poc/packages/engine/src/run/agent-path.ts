// 에이전트 길 기억(발급 사다리 0원 칸, 2026-11-16): 브라우저 에이전트(jev, 걸음마다 약 11원)가 막힌 묶음을 끝냈고 돌아간 스크립트의 확인 스텝까지
// 통과하면, 그 걸음들(동작·요소의 역할·접근성 이름·DOM id·값토큰)을 PC에 남긴다. 다음에 같은 스텝이 막히면 판정·에이전트·위치 찾기 전에
// 그 걸음을 모델 없이 그대로 다시 걷는다(0원). 한 걸음이라도 요소가 없거나 가드가 거부하면 그 길을 버리고 원래 사슬로 간다.
// 지키는 것:
// - 값은 남기지 않는다. 값토큰({{inputs.…}})만 남기고, 다시 걸을 때 이번 실행 값으로 바꾼다(BrowserAgent와 같다).
// - 다시 걷는 동작도 BrowserAgent.exec 하나를 지난다: 실행 사본 사전 임시 항목 → resolveTarget(유일·역할·이름) → GuardedActuator(R-A1·R-A2·정책·비밀 칸),
//   커밋 요소 거부, 금지 이름 단추는 그 걸음의 목표 click 스텝이 검토된 항목일 때만. 에이전트가 할 수 없던 것은 다시 걷기도 못 한다.
// - 묶음이 달라지면(패키지가 목표 스텝·항목을 고치면) 길 지문이 달라져 쓰지 않는다. 기한 HEAL_TTL_MS, 패키지당 PATH_MAX개.
// - 돌아간 확인 스텝(대화상자 대기·되읽기·게이트 본문 대조 등)이 통과해야만 남긴다. 그 확인은 늘 스크립트가 한다.
import { createHash } from 'node:crypto';
import { entryFingerprint, HEAL_TTL_MS } from '../core/heal-memory.ts';
import type { SelectorDict } from '../core/types.ts';
import type { JsonStore } from './heal-store.ts';

export const PATH_MAX = 32;
export const PATH_MAX_ACTIONS = 25;

/** 한 걸음. 요소는 역할·접근성 이름·DOM id로 다시 찾는다(목록 번호는 화면마다 다르다). */
export interface PathAction {
  action: 'click' | 'type' | 'select' | 'wait' | 'scroll';
  el: { role: string; name: string; id: string | null } | null;
  token: string | null;
  option: string | null;
  step: string | null;
}

export interface AgentPath {
  sig: string;
  resume: string;
  actions: PathAction[];
  at: number;
  /** 다시 걷기 연속 실패 수(PATH_MISS_LIMIT이면 버린다). */
  misses?: number;
}

/** 다시 걷기가 이만큼 연속 실패하면 길을 버린다(화면이 늦게 그려진 한 번으로 버리지 않게). */
export const PATH_MISS_LIMIT = 2;

export interface AgentPathFile {
  v: 1;
  paths: Record<string, AgentPath>;
}

/** 길 지문: 묶음 스텝 id·종류·항목 지문·돌아갈 스텝. */
export function planSignature(goal: ReadonlyArray<{ stepId: string; kind: string; key: string; token: string | null }>, resume: string, pkg: SelectorDict): string {
  const basis = JSON.stringify([resume, goal.map((g) => [g.stepId, g.kind, g.key, g.token, pkg.entries[g.key] ? entryFingerprint(pkg.entries[g.key]!) : null])]);
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

export class AgentPathMemory {
  private readonly store: JsonStore<AgentPathFile>;
  private readonly now: () => number;
  private readonly journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  private file: AgentPathFile;
  /** 에이전트가 done을 낸 길(돌아간 확인 스텝이 통과해야 남긴다). */
  private pending: { stepId: string; path: AgentPath } | null = null;
  private replayed: { stepId: string; resume: string } | null = null;

  constructor(store: JsonStore<AgentPathFile>, o: { now?: () => number; journal?: (type: string, payload?: Record<string, string | number | boolean>) => void } = {}) {
    this.store = store;
    this.now = o.now ?? Date.now;
    this.journal = o.journal ?? (() => {});
    let f: AgentPathFile | null;
    try {
      f = store.read();
    } catch {
      f = null;
    }
    this.file = f && f.v === 1 && f.paths && typeof f.paths === 'object' ? f : { v: 1, paths: {} };
  }

  /** 이 스텝·지문의 쓸 수 있는 길. */
  get(stepId: string, sig: string): AgentPath | null {
    const p = this.file.paths[stepId];
    if (!p || p.sig !== sig || !Array.isArray(p.actions) || !p.actions.length || p.actions.length > PATH_MAX_ACTIONS) return null;
    if (this.now() - p.at > HEAL_TTL_MS || this.now() < p.at - 60_000) return null;
    return p;
  }

  has(stepId: string): boolean {
    return !!this.file.paths[stepId];
  }

  /** 에이전트가 묶음을 끝냈다(done). 돌아간 스텝이 통과하면 confirmed가 남긴다. */
  propose(stepId: string, path: Omit<AgentPath, 'at'>): void {
    if (!path.actions.length || path.actions.length > PATH_MAX_ACTIONS) return;
    this.pending = { stepId, path: { ...path, at: this.now() } };
  }

  /** 실행기 step.finished(코드 없음). 돌아간 확인 스텝이 통과했으면 길을 남긴다. */
  confirmed(stepId: string): void {
    const r = this.replayed;
    if (r?.resume === stepId) {
      this.replayed = null;
      const p = this.file.paths[r.stepId];
      if (p?.misses) {
        p.misses = 0;
        this.flush();
      }
    }
    const p = this.pending;
    if (!p || p.path.resume !== stepId) return;
    this.pending = null;
    this.file.paths[p.stepId] = p.path;
    const keys = Object.keys(this.file.paths);
    if (keys.length > PATH_MAX) {
      keys.sort((a, b) => this.file.paths[a]!.at - this.file.paths[b]!.at);
      for (const k of keys.slice(0, keys.length - PATH_MAX)) delete this.file.paths[k];
    }
    this.journal('agentpath.learned', { stepId: p.stepId, actions: p.path.actions.length, resume: p.path.resume });
    this.flush();
  }

  /** 다시 걷기가 실패했다: 연속 PATH_MISS_LIMIT번이면 버린다. 버렸으면 true. */
  missed(stepId: string, code: string): boolean {
    const p = this.file.paths[stepId];
    if (!p) return false;
    p.misses = (p.misses ?? 0) + 1;
    if (p.misses >= PATH_MISS_LIMIT) {
      this.forget(stepId, code);
      return true;
    }
    this.journal('agentpath.missed', { stepId, code, misses: p.misses });
    this.flush();
    return false;
  }

  /** 돌아간 스텝이 실패했거나 다시 걷기가 거듭 실패했다: 버린다. */
  forget(stepId: string, code: string): void {
    if (this.pending?.stepId === stepId) this.pending = null;
    if (!this.file.paths[stepId]) return;
    delete this.file.paths[stepId];
    this.journal('agentpath.forgot', { stepId, code });
    this.flush();
  }

  /** 다시 걸은 길: 돌아간 스텝이 실패하면 버린다. */
  replaying(stepId: string, resume: string): void {
    this.replayed = { stepId, resume };
  }

  /** 실행기 step.finished(코드 있음): 돌아간 스텝이 실패했다. 기다리던 길은 남기지 않고, 다시 걸은 길은 버린다. */
  failed(stepId: string, code: string): void {
    if (this.pending && this.pending.path.resume === stepId) this.pending = null;
    const r = this.replayed;
    if (r && r.resume === stepId) {
      this.replayed = null;
      this.forget(r.stepId, code);
    }
  }

  snapshot(): AgentPathFile {
    return JSON.parse(JSON.stringify(this.file)) as AgentPathFile;
  }

  private flush(): void {
    try {
      this.store.write(this.file);
    } catch {
      this.journal('agentpath.store_failed');
    }
  }
}
