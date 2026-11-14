// 사람 비밀 입력 창 포트(M2-3, D05 §3.5, D02 §4 human kind=secret·sign cert, ADR-005 v3). RunController HumanPort.secret의 금고 쪽이다.
// - 금고 secretWindow.openForHuman {runId, targetId, frame, element}: 금고가 그 칸을 활성 창으로 열고 엔진 CDP를 막는다.
//   사용자가 전용 브라우저의 그 칸에 직접 친다. 값은 엔진에 오지 않는다(②). 끝나면 금고가 secret_window.closed{targetId}를 보낸다.
// - TTL이 지나면 secretWindow.requestClose를 부르고 'ttl'이다(포커스가 남아 있어 금고가 거부해도 'ttl': 조율기가 핸드오프한다).
// - element는 사전 항목의 css 후보다(금고가 격리 월드에서 querySelector). frame은 지금 main만(하위 프레임 id 매핑은 아직 없다).
//   창을 열지 못하면(css 후보 없음·하위 프레임·금고 거부) 사유 코드를 저널에 남기고 'ttl'로 돌려준다(조율기는 사람 차례 시간 초과로 다룬다).
// - 사람에게 "브라우저 칸에 입력" 안내는 main 몫이다(announce·closed 훅). 프롬프트 키만 넘긴다.
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
  /** main 안내(입력 칸을 보라). 값·화면 문구 없음, 프롬프트 키만. */
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

  /**
   * secret과 같지만 창을 열지 못한 사유를 돌려준다(CertSecretPort가 사람 직접 입력 대기로 바꿀지 정한다).
   * signal이 끊기면(사용자 [중지]) 창 닫기를 요청하고 'aborted'다.
   */
  async open(r: { runId: string; stepId: string; target?: string; prompt?: string; ttlMs: number; signal?: AbortSignal }): Promise<'done' | 'ttl' | 'aborted' | { refused: string }> {
    const refuse = (reason: string): { refused: string } => {
      const why = REASON.test(reason) ? reason : 'other';
      this.i.journal('human.secret_refused', { stepId: r.stepId, reason: why });
      this.i.closed?.({ runId: r.runId, stepId: r.stepId, why: 'refused' });
      return { refused: why };
    };
    const e = r.target ? this.i.dict.entries[r.target] : undefined;
    if (!e) return refuse('no_target');
    // frame: 'main' 또는 iframe 선택자(홈택스 인증서 창 iframe#dscert). 금고가 그 iframe의 하위 프레임에서 칸을 찾는다(같은 출처일 때만).
    if (!e.frame) return refuse('frame_unsupported');
    const css = e.candidates.find((c) => c.kind === 'css');
    if (!css || css.kind !== 'css') return refuse('no_css_candidate');
    const targetId = this.i.targetId();
    // 닫힘 이벤트는 열기 전에 듣는다(사용자가 빨리 끝내도 놓치지 않는다).
    let resolveClosed!: () => void;
    const closed = new Promise<'done'>((res) => (resolveClosed = () => res('done')));
    const off = this.i.vault.on('secret_window.closed', (d) => {
      if (d.targetId === targetId) resolveClosed();
    });
    try {
      const open = await this.i.vault.rpc<{ ok?: unknown; reason?: unknown }>('secretWindow.openForHuman', { runId: r.runId, targetId, frame: e.frame, element: css.value }).catch(() => ({ ok: false, reason: 'port_error' }));
      if (open?.ok !== true) return refuse(typeof open?.reason === 'string' ? open.reason : 'other');
      this.i.journal('human.secret_opened', { stepId: r.stepId });
      this.i.announce?.({ runId: r.runId, stepId: r.stepId, ...(r.prompt !== undefined ? { prompt: r.prompt } : {}), ttlMs: r.ttlMs });
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
