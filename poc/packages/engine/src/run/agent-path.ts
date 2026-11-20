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

  get(stepId: string, sig: string): AgentPath | null {
    const p = this.file.paths[stepId];
    if (!p || p.sig !== sig || !Array.isArray(p.actions) || !p.actions.length || p.actions.length > PATH_MAX_ACTIONS) return null;
    if (this.now() - p.at > HEAL_TTL_MS || this.now() < p.at - 60_000) return null;
    return p;
  }

  has(stepId: string): boolean {
    return !!this.file.paths[stepId];
  }

  propose(stepId: string, path: Omit<AgentPath, 'at'>): void {
    if (!path.actions.length || path.actions.length > PATH_MAX_ACTIONS) return;
    this.pending = { stepId, path: { ...path, at: this.now() } };
  }

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

  forget(stepId: string, code: string): void {
    if (this.pending?.stepId === stepId) this.pending = null;
    if (!this.file.paths[stepId]) return;
    delete this.file.paths[stepId];
    this.journal('agentpath.forgot', { stepId, code });
    this.flush();
  }

  replaying(stepId: string, resume: string): void {
    this.replayed = { stepId, resume };
  }

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
