// 대화 의도(M4-3 ③, D01 §5.1, D04 §3 intent_route_v1): renderer → main → engine `intent.resolve`(L0 규칙 → 마스킹 → 게이트웨이 판정) → 확인 카드.
// - 엔진은 고른 작업(플레이북 ID)과 세무 질문이 섞였는지만 돌려준다. 인자(거래처·금액·부가세)는 지금처럼 main의 로컬 파서가 뽑고(금액 파서 로컬, D01 §5.1),
//   확인 카드(초안)는 사용자가 [발급 준비]를 눌러야 실행된다. 대화만으로 실행하지 않는다.
// - 오프라인 해석은 없다(사용자 결정 2026-11-10): 엔진에 명령이 없거나(unknown_method) 판정을 못 하면(decide.unavailable·시간 초과)
//   의도를 정규식으로 대신 고르지 않고 "연결 안 됨"(INTENT_UNAVAILABLE_TEXT)과 [다시 시도]를 보인다.
// - 응답은 신뢰하지 않는다: 모양이 다르면 연결 안 됨과 같다. 로그에는 결과 종류·경로만 남긴다(문장 없음).
import type { CertCode } from './cert-docs.ts';
import type { Parsed } from './shell-model.ts';

/** intent_route_v1 선택지(packages/model/bundles/intent_route_v1.json의 choices, none_of_these 제외). */
export const INTENT_PLAYBOOKS = [
  'hometax.invoice.issue', 'hometax.invoice.list', 'hometax.invoice.amend', 'hometax.cert.business', 'hometax.cert.taxpayment', 'hometax.summary.view',
  'counterparty.bizstatus.check', 'gov24.resident.copy', 'gov24.localtax.cert', 'gov24.nhis.eligibility', 'gov24.land.register', 'gov24.localtax.itemized',
  'sminfo.sme.cert', 'fourins.paid.cert', 'query.documents', 'hometax.card.refresh', 'bundle.monthly', 'payroll.ledger',
] as const;
export type IntentPlaybook = (typeof INTENT_PLAYBOOKS)[number];

/** 엔진 `intent.resolve` 결과(계약 제안, desktop-pending.md 「M4-3 ③」). */
export type IntentRoute =
  | { outcome: 'route'; playbook: IntentPlaybook; adviceMentioned: boolean; via: 'l0' | 'model' }
  | { outcome: 'refuse_advice'; via: 'model' }
  | { outcome: 'unknown'; via: 'l0' | 'model' };

/** D04 §3 세무 상담 출력 차단 고정 문구. */
export const ADVICE_TEXT = '세무 판단은 하지 않아요. 세무 대리인과 상담해 주세요.';

/** 판정을 못 했을 때(게이트웨이 불가·시간 초과·모양 다름) 대화에 보이는 문장. 렌더러가 [다시 시도]를 붙인다. */
export const INTENT_UNAVAILABLE_TEXT = '지금 AI 모델에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.';

/** 온보딩 ②(모델 처리 동의) 전에 대화를 보냈을 때. 문장은 모델로 가지 않는다. */
export const MODEL_CONSENT_FIRST_TEXT = '대화는 AI 모델로 해석해요. 등록 중인 화면에서 모델 처리에 동의하면 바로 쓸 수 있어요.';

/** 엔진 응답 → IntentRoute. 모양이 다르면 null(연결 안 됨). */
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

/** 화면 이름(아직 대화에서 열지 않는 작업의 안내 문구). */
const SOON: Partial<Record<IntentPlaybook, string>> = {
  'hometax.invoice.list': '세금계산서 조회',
  'hometax.invoice.amend': '수정세금계산서 발급',
  'hometax.summary.view': '매출·매입 합계 조회',
  'counterparty.bizstatus.check': '거래처 상태 확인',
  'query.documents': '보관함 조회',
  'hometax.card.refresh': '사업용 카드 내역',
  'bundle.monthly': '세무사 꾸러미',
  'payroll.ledger': '급여대장',
};
const CERT: readonly IntentPlaybook[] = ['hometax.cert.business', 'hometax.cert.taxpayment', 'gov24.localtax.cert', 'gov24.nhis.eligibility', 'gov24.land.register', 'gov24.localtax.itemized', 'sminfo.sme.cert', 'fourins.paid.cert'];
/** 옛 의도 id(intent_route_v1) → 이 앱이 떼는 민원증명(cert-docs 표). 나머지 CERT는 떼지 않는 증명서다. */
const CERT_CODE: Partial<Record<IntentPlaybook, CertCode>> = { 'hometax.cert.business': 'H-03', 'hometax.cert.taxpayment': 'H-04' };

export type Routed = { parsed: Parsed; note: string | null } | { say: string; note: null };

/**
 * 엔진이 고른 작업을 화면 해석(Parsed)으로 옮긴다. 인자는 로컬 파서(local) 그대로, 의도만 엔진 것으로 바꾼다.
 * 세무 질문이 섞였으면(adviceMentioned) 작업은 그대로 하고 고정 문구를 같이 보인다(D04 §3).
 */
export function routed(r: IntentRoute, local: Parsed): Routed {
  if (r.outcome === 'refuse_advice') return { say: ADVICE_TEXT, note: null };
  if (r.outcome === 'unknown') return { parsed: { ...local, intent: 'other' }, note: null };
  const note = r.adviceMentioned ? ADVICE_TEXT : null;
  const p = r.playbook;
  if (p === 'hometax.invoice.issue') return { parsed: { ...local, intent: 'invoice' }, note };
  if (p === 'gov24.resident.copy') return { parsed: { ...local, intent: local.intent === 'resident_abstract' ? 'resident_abstract' : 'resident_copy' }, note };
  if (CERT.includes(p)) return { parsed: { ...local, intent: 'cert', cert: local.cert ?? CERT_CODE[p] ?? null }, note };
  const soon = SOON[p];
  return soon ? { say: `${soon}은(는) 곧 이 대화에서 열 수 있어요. 지금은 세금계산서 발급, 홈택스 증명서(사업자등록증명·납세증명서 등) 발급, 정부24 직접 발급 안내를 할 수 있어요.`, note: null } : { parsed: { ...local, intent: 'other' }, note };
}

export interface IntentResolver {
  /** null이면 판정 못 함(엔진에 명령 없음·판정 불가·시간 초과·모양 다름). fallback은 그 이유 코드(로그용). */
  resolve(text: string): Promise<{ route: IntentRoute | null; fallback: string | null }>;
}

/** 엔진 rpc 위의 해석기. 상한 시간 안에 답이 없으면 판정 못 함(timeout). */
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
