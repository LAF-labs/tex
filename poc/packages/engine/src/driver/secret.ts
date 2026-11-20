import type { HumanPort } from '../run/controller.ts';
import type { SelectorDict } from '../core/types.ts';

type Json = Record<string, unknown>;

export interface SecretVault {
  rpc<T>(method: string, params?: Json): Promise<T>;
  on(name: string, fn: (data: Json) => void): () => void;
}

export interface VaultSecretInput {
  vault: SecretVault;
  targetId(): string;
  dict: SelectorDict;
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
  announce?(r: { runId: string; stepId: string; prompt?: string; ttlMs: number }): void;
  closed?(r: { runId: string; stepId: string; why: 'done' | 'ttl' | 'refused' }): void;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const REASON = /^[a-z_]{1,40}$/;
const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export class VaultSecretPort implements Pick<HumanPort, 'secret'> {
  private readonly i: VaultSecretInput;

  constructor(i: VaultSecretInput) {
    this.i = i;
  }

  async secret(r: { runId: string; stepId: string; target?: string; prompt?: string; ttlMs: number }): Promise<'done' | 'ttl'> {
    const out = await this.open(r);
    return out === 'done' ? 'done' : 'ttl';
  }

  async open(r: { runId: string; stepId: string; target?: string; prompt?: string; ttlMs: number; signal?: AbortSignal }): Promise<'done' | 'ttl' | 'aborted' | { refused: string }> {
    const refuse = (reason: string): { refused: string } => {
      const why = REASON.test(reason) ? reason : 'other';
      this.i.journal('human.secret_refused', { stepId: r.stepId, reason: why });
      this.i.closed?.({ runId: r.runId, stepId: r.stepId, why: 'refused' });
      return { refused: why };
    };
    const e = r.target ? this.i.dict.entries[r.target] : undefined;
    if (!e) return refuse('no_target');
    if (!e.frame) return refuse('frame_unsupported');
    const css = e.candidates.find((c) => c.kind === 'css');
    if (!css || css.kind !== 'css') return refuse('no_css_candidate');
    const targetId = this.i.targetId();
    let resolveClosed!: () => void;
    const closed = new Promise<'done'>((res) => (resolveClosed = () => res('done')));
    const off = this.i.vault.on('secret_window.closed', (d) => {
      if (d.targetId === targetId) resolveClosed();
    });
    try {
      const open = await this.i.vault.rpc<{ ok?: unknown; reason?: unknown; auto?: unknown }>('secretWindow.openForHuman', { runId: r.runId, targetId, frame: e.frame, element: css.value }).catch(() => ({ ok: false, reason: 'port_error' }));
      if (open?.ok !== true) return refuse(typeof open?.reason === 'string' ? open.reason : 'other');
      this.i.journal('human.secret_opened', { stepId: r.stepId });
      if (!('auto' in open) || open.auto !== true) this.i.announce?.({ runId: r.runId, stepId: r.stepId, ...(r.prompt !== undefined ? { prompt: r.prompt } : {}), ttlMs: r.ttlMs });
      let cancel = () => {};
      const ttl = new Promise<'ttl'>((res) => (cancel = (this.i.setTimer ?? defaultTimer)(() => res('ttl'), r.ttlMs)));
      let onAbort = () => {};
      const aborted = new Promise<'aborted'>((res) => {
        onAbort = () => res('aborted');
        if (r.signal?.aborted) onAbort();
        else r.signal?.addEventListener('abort', onAbort, { once: true });
      });
      const out = await Promise.race([closed, ttl, aborted]);
      cancel();
      r.signal?.removeEventListener('abort', onAbort);
      if (out !== 'done') await this.i.vault.rpc('secretWindow.requestClose', { runId: r.runId, targetId }).catch(() => {});
      this.i.journal(out === 'done' ? 'human.secret_done' : out === 'ttl' ? 'human.secret_ttl' : 'human.secret_aborted', { stepId: r.stepId });
      this.i.closed?.({ runId: r.runId, stepId: r.stepId, why: out === 'aborted' ? 'ttl' : out });
      return out;
    } finally {
      off();
    }
  }
}
