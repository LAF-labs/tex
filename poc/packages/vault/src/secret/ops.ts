import type { EventLog } from '@sax/platform';
import { hostAllowed, type RelayPolicy } from '../relay/policy.ts';
import type { Relay, TargetState } from '../relay/relay.ts';
import { knownValueVariants } from '../relay/sanitize.ts';

type Json = Record<string, unknown>;

export type FillReason = 'denied' | 'not_found' | 'blocked_by_module' | 'origin_not_allowed' | 'not_secret_slot' | 'secret_window_refused';

export interface FillRequest {
  runId: string;
  targetId: string;
  /** 'main' 또는 CDP frameId. */
  frame: string;
  /** CSS 셀렉터(PoC). Phase 1은 셀렉터 사전 ElementLocator. */
  element: string;
  secret: { kind: string; scope: string; row?: number };
}

/**
 * PoC는 비밀을 저장하지 않는다(ADR-017). 사용자가 금고 직결 입력 창에서 넣은 값을 한 번만 쓰고 지운다.
 * main·렌더러 본체는 이 값을 중계하지 않는다(입력 창 포트는 금고에 직결).
 */
export class OneShotSecrets {
  private readonly items = new Map<string, Uint8Array>();
  private key(kind: string, scope: string, row?: number) {
    return `${kind}/${scope}/${row ?? ''}`;
  }
  provide(kind: string, scope: string, bytes: Uint8Array, row?: number): void {
    const k = this.key(kind, scope, row);
    this.items.get(k)?.fill(0);
    this.items.set(k, bytes);
  }
  take(kind: string, scope: string, row?: number): Uint8Array | null {
    const k = this.key(kind, scope, row);
    const v = this.items.get(k) ?? null;
    this.items.delete(k);
    return v;
  }
  has(kind: string, scope: string): boolean {
    return [...this.items.keys()].some((k) => k.startsWith(`${kind}/${scope}/`));
  }
  clear(): void {
    for (const v of this.items.values()) v.fill(0);
    this.items.clear();
  }
}

interface Probe {
  type: string;
  active: boolean;
  connected: boolean;
  len: number;
}

const PROBE_FN = `function () {
  let a = this.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return { type: String(this.type || '').toLowerCase(), active: a === this, connected: this.isConnected, len: typeof this.value === 'string' ? this.value.length : 0 };
}`;

interface HumanWatch {
  objectId: string;
  timer: NodeJS.Timeout;
}

/** 비밀 창(D05 §3.5)과 타이피스트(D05 §4). 모든 동작은 금고 감시 세션에서 한다. */
export class SecretOps {
  private readonly relay: Relay;
  private readonly policy: RelayPolicy;
  private readonly log: EventLog;
  readonly secrets = new OneShotSecrets();
  /** main이 알려 준 실행 트리거(엔진의 주장으로 받지 않는다). */
  readonly runTriggers = new Map<string, 'local' | 'remote' | 'daemon'>();
  private readonly human = new Map<string, HumanWatch>();
  /** 비밀 창 개시 조건(Preferences·확장·Google 로그인) 위반 사유. null이면 통과. */
  openBlocker: () => string | null = () => 'profile_not_checked';

  constructor(relay: Relay, policy: RelayPolicy, log: EventLog) {
    this.relay = relay;
    this.policy = policy;
    this.log = log;
  }

  private async resolve(t: TargetState, frame: string, selector: string): Promise<{ objectId: string; backendNodeId: number; frameId: string; frameUrl: string } | null> {
    const frameId = frame === 'main' ? t.mainFrameId : frame;
    if (!frameId) return null;
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: '__sax_vault' }, t.vaultSession);
    const ev = await this.relay.send<{ result: Json }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, contextId: executionContextId }, t.vaultSession);
    const objectId = ev.result.objectId as string | undefined;
    if (!objectId) return null;
    const { node } = await this.relay.send<{ node: Json }>('DOM.describeNode', { objectId }, t.vaultSession);
    const { frameTree } = await this.relay.send<{ frameTree: Json }>('Page.getFrameTree', {}, t.vaultSession);
    return { objectId, backendNodeId: Number(node.backendNodeId), frameId, frameUrl: findFrameUrl(frameTree, frameId) ?? '' };
  }

  private async probe(t: TargetState, objectId: string): Promise<Probe | null> {
    try {
      const r = await this.relay.send<{ result: { value: Probe } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: PROBE_FN, returnByValue: true }, t.vaultSession);
      return r.result.value;
    } catch {
      return null;
    }
  }

  private refuse(reason: string): { ok: false; reason: 'secret_window_refused' } {
    this.log.event('vault.secret_window_refused', { reason });
    return { ok: false, reason: 'secret_window_refused' };
  }

  async fill(req: FillRequest): Promise<{ ok: boolean; reason?: FillReason }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t) return { ok: false, reason: 'not_found' };
    const trigger = this.runTriggers.get(req.runId);
    if (!trigger || trigger === 'daemon') return { ok: false, reason: 'denied' };
    if (t.win) return { ok: false, reason: 'denied' };
    const blocker = this.openBlocker();
    if (blocker) return this.refuse(blocker);
    const el = await this.resolve(t, req.frame, req.element).catch(() => null);
    if (!el) return { ok: false, reason: 'not_found' };
    const hosts = this.policy.secretHosts[req.secret.kind] ?? [];
    if (!hostAllowed(hostOf(el.frameUrl), hosts)) return { ok: false, reason: 'origin_not_allowed' };
    const p0 = await this.probe(t, el.objectId);
    if (!p0 || p0.type !== 'password') return { ok: false, reason: 'not_secret_slot' };
    if (!p0.active) return { ok: false, reason: 'denied' };
    const secret = this.secrets.take(req.secret.kind, req.secret.scope, req.secret.row);
    if (!secret) return { ok: false, reason: 'denied' };

    // Phase 1 한계(D05 §8): CDP JSON 직렬화 때문에 금고 힙에 문자열 사본이 생긴다(엔진 힙에는 없다).
    const text = new TextDecoder().decode(secret);
    secret.fill(0);
    this.relay.openWindow(t, 'typist', el.frameId, el.backendNodeId);
    let ok = true;
    let reason: FillReason | undefined;
    const keyEvents = this.policy.typistInput === 'keyEvents';
    try {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: true }, t.vaultSession);
      for (const ch of text) {
        const p = await this.probe(t, el.objectId);
        if (!p || !p.active || p.type !== 'password' || !p.connected) {
          ok = false;
          reason = 'denied';
          break;
        }
        if (keyEvents) {
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, t.vaultSession);
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, t.vaultSession);
        } else {
          await this.relay.send('Input.insertText', { text: ch }, t.vaultSession);
        }
        if (this.policy.keyDelayMs > 0) await sleep(this.policy.keyDelayMs);
      }
      if (ok) {
        const p = await this.probe(t, el.objectId);
        if (!p || p.len !== [...text].length) {
          ok = false;
          reason = 'blocked_by_module';
        }
      }
    } finally {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: false }, t.vaultSession).catch(() => {});
      this.relay.addKnownSecret(knownValueVariants(text));
      this.relay.deactivateWindow(t);
    }
    this.log.event('secret.used', { kind: req.secret.kind, viaTypist: true, ok });
    return ok ? { ok } : { ok, reason };
  }

  async openForHuman(req: { runId: string; targetId: string; frame: string; element: string }): Promise<{ ok: boolean; reason?: 'secret_window_refused' | 'origin_not_allowed' | 'not_found' }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t || t.win) return { ok: false, reason: 'not_found' };
    const blocker = this.openBlocker();
    if (blocker) return this.refuse(blocker);
    const el = await this.resolve(t, req.frame, req.element).catch(() => null);
    if (!el) return { ok: false, reason: 'not_found' };
    const hosts = Object.values(this.policy.secretHosts).flat();
    if (!hostAllowed(hostOf(el.frameUrl), hosts)) return { ok: false, reason: 'origin_not_allowed' };
    this.relay.openWindow(t, 'human', el.frameId, el.backendNodeId);
    const watch: HumanWatch = {
      objectId: el.objectId,
      timer: setInterval(() => void this.tickHuman(t), 250),
    };
    this.human.set(t.targetId, watch);
    return { ok: true };
  }

  /** 활성 창 종료 조건 (나)·(다): blur + 값 있음, 노드 분리. 문서 커밋은 Relay가 처리한다. */
  private async tickHuman(t: TargetState): Promise<void> {
    const w = this.human.get(t.targetId);
    if (!w) return;
    if (t.win?.phase !== 'active') {
      this.stopHuman(t.targetId);
      return;
    }
    const p = await this.probe(t, w.objectId);
    if (!p || !p.connected || (!p.active && p.len > 0)) await this.closeHuman(t);
  }

  private stopHuman(targetId: string): void {
    const w = this.human.get(targetId);
    if (w) clearInterval(w.timer);
    this.human.delete(targetId);
  }

  private async closeHuman(t: TargetState): Promise<void> {
    const w = this.human.get(t.targetId);
    this.stopHuman(t.targetId);
    if (w) {
      // 오염 상태 동안 엔진행 메시지에서 이 값을 지우기 위해 금고가 읽는다(금고는 TB-1).
      try {
        const r = await this.relay.send<{ result: { value?: string } }>('Runtime.callFunctionOn', { objectId: w.objectId, functionDeclaration: 'function(){return typeof this.value==="string"?this.value:""}', returnByValue: true }, t.vaultSession);
        if (r.result.value) this.relay.addKnownSecret(knownValueVariants(r.result.value));
      } catch {
        // 노드가 이미 분리됨
      }
    }
    this.relay.deactivateWindow(t);
    this.log.event('secret.used', { kind: 'human', viaTypist: false });
  }

  /** 사용자가 "입력 완료"를 눌렀다(main 승인 창이나 금고 UI에서 온 신호만, 엔진 신호 아님). */
  async userDone(targetId: string): Promise<void> {
    const t = this.relay.exposedTarget(targetId);
    if (t?.win?.phase === 'active' && t.win.kind === 'human') await this.closeHuman(t);
  }

  /** 엔진의 종료 요청(라): 대상 노드 포커스 해제를 확인한 뒤 승인. */
  async requestClose(req: { runId: string; targetId: string }): Promise<{ ok: boolean }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t?.win || t.win.phase !== 'active') return { ok: true };
    const w = this.human.get(t.targetId);
    const p = w ? await this.probe(t, w.objectId) : null;
    if (w && p && p.active) {
      this.log.event('vault.secret_window_close_denied', { target: t.targetId.slice(0, 8) });
      return { ok: false };
    }
    await this.closeHuman(t);
    return { ok: true };
  }

  shutdown(): void {
    for (const id of [...this.human.keys()]) this.stopHuman(id);
    this.secrets.clear();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function findFrameUrl(tree: Json, frameId: string): string | undefined {
  const frame = tree.frame as Json;
  if (frame.id === frameId) return String(frame.url) + String(frame.urlFragment ?? '');
  for (const c of (tree.childFrames as Json[]) ?? []) {
    const u = findFrameUrl(c, frameId);
    if (u) return u;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
