import type { OneShotBind, SecretKind } from '@sax/vault';

export type { SecretKind } from '@sax/vault';

/** 금고 프로토콜의 1회용 결속(OneShotBind, I-1). main → 금고 secretInput 포트에 붙인다. */
export type SecretInputBind = OneShotBind;

/** 금고의 secret.needed(I-2) 데이터. */
interface SecretNeeded extends OneShotBind {
  targetId: string;
}

export const SECRET_LABELS: Record<SecretKind, string> = {
  cert_password: '공동인증서 비밀번호',
  portal_password: '홈택스 비밀번호',
};

const isKind = (k: unknown): k is SecretKind => typeof k === 'string' && Object.hasOwn(SECRET_LABELS, k);

/** secret.needed 데이터 모양 검사. 하나라도 어긋나면 null(창을 열지 않는다). */
export function parseSecretNeeded(d: unknown): SecretNeeded | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.runId)) return null;
  if (typeof o.targetId !== 'string' || !o.targetId || o.targetId.length > 128) return null;
  if (!isKind(o.kind)) return null;
  if (o.scope !== 'business' && o.scope !== 'personal') return null;
  return { runId: o.runId, targetId: o.targetId, kind: o.kind, scope: o.scope };
}

/**
 * 비밀 창은 동시에 하나, 활성 실행의 요청만 연다. 창이 열려 있을 때 온 요청은 마지막 하나를 들고
 * 있다가 창이 닫히면 넘긴다(창은 금고가 받은 뒤 잠시 있다 닫힌다).
 */
export class SecretWindowCoordinator {
  private current: SecretNeeded | null = null;
  private next: SecretNeeded | null = null;
  private readonly isActiveRun: (runId: string) => boolean;

  constructor(isActiveRun: (runId: string) => boolean) {
    this.isActiveRun = isActiveRun;
  }

  /** 열어도 되면 그 요청(이때부터 열린 것으로 친다), 아니면 null. */
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

  /** 창이 닫혔다. 그동안 들고 있던 요청이 있으면 돌려준다(다시 request로 연다). */
  closed(): SecretNeeded | null {
    this.current = null;
    const n = this.next;
    this.next = null;
    return n;
  }
}
