import type { OneShotBind, SecretKind } from '@sax/vault';

export type { SecretKind } from '@sax/vault';

export type SecretInputBind = OneShotBind;

interface SecretNeeded extends OneShotBind {
  targetId: string;
}

export const SECRET_LABELS: Record<SecretKind, string> = {
  cert_password: '공동인증서 비밀번호',
  portal_password: '홈택스 비밀번호',
};

const isKind = (k: unknown): k is SecretKind => typeof k === 'string' && Object.hasOwn(SECRET_LABELS, k);

export function parseSecretNeeded(d: unknown): SecretNeeded | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.runId)) return null;
  if (typeof o.targetId !== 'string' || !o.targetId || o.targetId.length > 128) return null;
  if (!isKind(o.kind)) return null;
  if (o.scope !== 'business' && o.scope !== 'personal') return null;
  return { runId: o.runId, targetId: o.targetId, kind: o.kind, scope: o.scope };
}

export class SecretWindowCoordinator {
  private current: SecretNeeded | null = null;
  private next: SecretNeeded | null = null;
  private readonly isActiveRun: (runId: string) => boolean;

  constructor(isActiveRun: (runId: string) => boolean) {
    this.isActiveRun = isActiveRun;
  }

  request(data: unknown): SecretNeeded | null {
    const r = parseSecretNeeded(data);
    if (!r || !this.isActiveRun(r.runId)) return null;
    if (this.current) {
      this.next = r;
      return null;
    }
    this.current = r;
    return r;
  }

  get open(): SecretNeeded | null {
    return this.current;
  }

  closed(): SecretNeeded | null {
    this.current = null;
    const n = this.next;
    this.next = null;
    return n;
  }
}
