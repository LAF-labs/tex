import { CHAT_ADVICE_TEXT } from '@sax/chat-core';
import type { CertCode } from './cert-docs.ts';
import type { Parsed } from './shell-model.ts';

export const INTENT_PLAYBOOKS = [
  'hometax.invoice.issue', 'hometax.invoice.list', 'hometax.invoice.amend', 'hometax.cert.business', 'hometax.cert.taxpayment', 'hometax.summary.view',
  'counterparty.bizstatus.check', 'gov24.resident.copy', 'gov24.localtax.cert', 'gov24.nhis.eligibility', 'gov24.land.register', 'gov24.localtax.itemized',
  'sminfo.sme.cert', 'fourins.paid.cert', 'query.documents', 'hometax.card.refresh', 'bundle.monthly', 'payroll.ledger',
] as const;
type IntentPlaybook = (typeof INTENT_PLAYBOOKS)[number];

export type IntentRoute =
  | { outcome: 'route'; playbook: IntentPlaybook; adviceMentioned: boolean; via: 'l0' | 'model' }
  | { outcome: 'refuse_advice'; via: 'model' }
  | { outcome: 'unknown'; via: 'l0' | 'model' };

export const INTENT_UNAVAILABLE_TEXT = '지금은 답을 받을 수 없어요. 인터넷 연결을 확인하고 [다시 시도]를 눌러 주세요.';

export const MODEL_CONSENT_FIRST_TEXT = '대화는 AI 모델로 해석해요. 등록 중인 화면에서 모델 처리에 동의하면 바로 쓸 수 있어요.';

export function parseRoute(v: unknown): IntentRoute | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const via = r.via === 'l0' || r.via === 'model' ? r.via : null;
  if (!via) return null;
  if (r.outcome === 'route') {
    if (typeof r.playbook !== 'string' || !(INTENT_PLAYBOOKS as readonly string[]).includes(r.playbook) || typeof r.adviceMentioned !== 'boolean') return null;
    return { outcome: 'route', playbook: r.playbook as IntentPlaybook, adviceMentioned: r.adviceMentioned, via };
  }
  if (r.outcome === 'refuse_advice') return via === 'model' ? { outcome: 'refuse_advice', via } : null;
  if (r.outcome === 'unknown') return { outcome: 'unknown', via };
  return null;
}

const SOON: Partial<Record<IntentPlaybook, string>> = {
  'hometax.invoice.list': '세금계산서 조회',
  'hometax.invoice.amend': '수정세금계산서 발급',
  'hometax.summary.view': '매출/매입 합계 조회',
  'counterparty.bizstatus.check': '거래처 상태 확인',
  'query.documents': '보관함 조회',
  'hometax.card.refresh': '사업용 카드 내역',
  'bundle.monthly': '세무사 꾸러미',
  'payroll.ledger': '급여대장',
};
const CERT: readonly IntentPlaybook[] = ['hometax.cert.business', 'hometax.cert.taxpayment', 'gov24.localtax.cert', 'gov24.nhis.eligibility', 'gov24.land.register', 'gov24.localtax.itemized', 'sminfo.sme.cert', 'fourins.paid.cert'];
const CERT_CODE: Partial<Record<IntentPlaybook, CertCode>> = { 'hometax.cert.business': 'H-03', 'hometax.cert.taxpayment': 'H-04' };

type Routed = { parsed: Parsed; note: string | null } | { say: string; note: null };

export function routed(r: IntentRoute, local: Parsed): Routed {
  if (r.outcome === 'refuse_advice') return { say: CHAT_ADVICE_TEXT, note: null };
  if (r.outcome === 'unknown') return { parsed: { ...local, intent: 'other' }, note: null };
  const note = r.adviceMentioned ? CHAT_ADVICE_TEXT : null;
  const p = r.playbook;
  if (p === 'hometax.invoice.issue') return { parsed: { ...local, intent: 'invoice' }, note };
  if (p === 'gov24.resident.copy') return { parsed: { ...local, intent: local.intent === 'resident_abstract' ? 'resident_abstract' : 'resident_copy' }, note };
  if (CERT.includes(p)) return { parsed: { ...local, intent: 'cert', cert: local.cert ?? CERT_CODE[p] ?? null }, note };
  const soon = SOON[p];
  return soon ? { say: `${soon}은(는) 곧 이 대화에서 열 수 있어요. 지금은 세금계산서 발급, 홈택스 증명서(사업자등록증명/납세증명서 등) 발급, 정부24 직접 발급 안내를 할 수 있어요.`, note: null } : { parsed: { ...local, intent: 'other' }, note };
}

export interface IntentResolver {
  resolve(text: string): Promise<{ route: IntentRoute | null; fallback: string | null }>;
}

export function engineIntentResolver(rpc: (m: string, p: Record<string, unknown>) => Promise<unknown>, timeoutMs = 4_000): IntentResolver {
  return {
    async resolve(text) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)));
      try {
        const v = await Promise.race([rpc('intent.resolve', { text }), timeout]);
        if (v === 'timeout') return { route: null, fallback: 'timeout' };
        const route = parseRoute(v);
        return route ? { route, fallback: null } : { route: null, fallback: 'shape' };
      } catch (e) {
        const m = (e as Error | null)?.message ?? '';
        return { route: null, fallback: m === 'unknown_method' ? 'unknown_method' : /^[a-z_]+\.[a-z_]+$/.test(m) ? m : 'error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
