// 대화 의도 판정 intent.resolve(M4-3 ③, D01 §5.1, D04 §3, 계약: 공유 노트 desktop-pending.md 「M4-3 ③」).
// renderer → main → 엔진 intent.resolve({text}) → L0 관측(로컬) → 마스킹(Redactor, 번들 maxInputBytes) → Judge.decide(intent_route_v1)
// → 게이트웨이(net/egress) → 로컬 매핑. 결과는 셋뿐이다: route·refuse_advice·unknown.
// - 판정만 한다. 실행·DB 쓰기·원장·저널이 없다. 금액·날짜·거래처는 main 로컬 파서가 뽑고, 카드에서 사람이 확인하기 전에는 아무것도 하지 않는다.
// - fail-closed: 모델 경로가 없거나(게이트웨이 미설정) 마스킹·게이트웨이·검사·공급사가 실패하면 decide.unavailable.
//   main은 그 코드로 확인 카드 없이 "연결 안 됨"과 [다시 시도]를 보인다(오프라인 해석 없음, 사용자 결정 2026-11-10). 판정이 불확실하면(매핑 unknown·사전 필터 강등) unknown이다.
// - 마스킹 사전: 거래처 상호·대표자·이메일·사업자번호와 내 프로필 상호·대표자. 금액(AMT)도 가린다(needsAmounts 아님).
// - 로그·저널에 문장·금액·거래처를 남기지 않는다(⑦). 결과 종류·via만 돌려준다.
import { randomUUID } from 'node:crypto';
import { CounterpartyRepo, ProfileRepo, type Db } from '@sax/db';
import { BundleCatalog, DefaultModelLayer, GatewayDecideAdapter, ThresholdProfiles, gatewayRunToken, type DecideResult, type RunToken } from '@sax/model';
import type { Egress } from '@sax/net';
import { Redactor } from '@sax/redaction';
import { Judge } from './l0/judge.ts';
import { loadPromotions } from './l0/promotion.ts';

export const INTENT_BUNDLE = 'intent_route_v1';
/** 입력창 문장 상한(계약 ≤ 2000자) */
export const INTENT_TEXT_MAX = 2000;
/** 대화 세션(마스킹·실행 토큰 범위)은 15분 쉬면 새로 연다(D06 §8 RedactorSessions와 같은 기준) */
const SESSION_IDLE_MS = 15 * 60 * 1000;
/** 세무 질문 판정 문턱(번들 매핑 refuse_advice와 같은 값, D04 §3) */
const ADVICE_GTE = 0.75;
/** 불확실(판정은 됐지만 고를 수 없음)로 보는 이유. 나머지 unknown 이유는 경로 실패라 decide.unavailable이다 */
const UNCERTAIN = new Set(['mapping_unknown', 'core_refusal', 'injection_prefilter']);

export type IntentResolution =
  | { outcome: 'route'; playbook: string; adviceMentioned: boolean; via: 'l0' | 'model' }
  | { outcome: 'refuse_advice'; via: 'model' }
  | { outcome: 'unknown'; via: 'l0' | 'model' };

export class IntentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface IntentModel {
  judge: Pick<Judge, 'decide'>;
  /** 대화 세션 범위 실행 토큰(게이트웨이 POST /v1/run-tokens) */
  runToken: (chatSessionId: string) => Promise<RunToken>;
  /** 번들 입력 상한(maxInputBytes)과 route 선택지 */
  bundle: { maxInputBytes: number; playbooks: readonly string[] };
}

export interface IntentResolverOptions {
  /** 모델 경로. null이면 모든 요청이 decide.unavailable(main은 연결 안 됨) */
  model: IntentModel | null;
  now?: () => number;
}

export class IntentResolver {
  private readonly db: Db;
  private readonly opts: IntentResolverOptions;
  private session: { id: string; lastAt: number; token: RunToken | null } | null = null;

  constructor(db: Db, opts: IntentResolverOptions) {
    this.db = db;
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async handle(method: string, p: Record<string, unknown>): Promise<IntentResolution> {
    if (method !== 'intent.resolve') throw new IntentError('unknown_method');
    const text = p?.text;
    if (typeof text !== 'string' || !text.trim() || [...text].length > INTENT_TEXT_MAX) throw new IntentError('bad_text');
    return this.resolve(text);
  }

  private async resolve(text: string): Promise<IntentResolution> {
    const m = this.opts.model;
    if (!m) throw new IntentError('decide.unavailable');
    const s = this.chatSession();
    let input;
    try {
      const red = new Redactor({ chatSessionId: s.id });
      this.addNames(red);
      input = red.apply(text, { frame: 'none' }).redacted;
    } catch {
      throw new IntentError('decide.unavailable');
    }
    // 마스킹 뒤 바이트가 번들 상한을 넘으면 모델에 보내지 않는다(잘라 보내면 뜻이 바뀐다)
    if (Buffer.byteLength(input, 'utf8') > m.bundle.maxInputBytes) throw new IntentError('decide.unavailable');
    let r: DecideResult;
    try {
      s.token ??= await m.runToken(s.id);
      r = await m.judge.decide(INTENT_BUNDLE, { kind: 'intent', text }, input, s.token);
    } catch {
      s.token = null;
      throw new IntentError('decide.unavailable');
    }
    return this.classify(r, m.bundle.playbooks, s);
  }

  private classify(r: DecideResult, playbooks: readonly string[], s: { token: RunToken | null }): IntentResolution {
    const via = r.l0Only ? 'l0' : 'model';
    if (r.outcome === 'route') {
      const a = r.raw.playbook;
      const playbook = a?.type === 'choice' ? a.value : null;
      if (!playbook || !playbooks.includes(playbook)) throw new IntentError('decide.unavailable');
      const advice = r.raw.mentions_tax_advice;
      // 세무 질문 답이 없으면(모델 미호출 등) 상담으로 본다(번들 onRefusal assume_true와 같은 쪽)
      const adviceMentioned = advice?.type === 'predicate' ? advice.probability >= ADVICE_GTE : true;
      return { outcome: 'route', playbook, adviceMentioned, via: a?.source === 'l0' ? 'l0' : 'model' };
    }
    if (r.outcome === 'refuse_advice') {
      if (r.l0Only) throw new IntentError('decide.unavailable');
      return { outcome: 'refuse_advice', via: 'model' };
    }
    if (r.outcome === 'unknown' && r.reason && UNCERTAIN.has(r.reason)) return { outcome: 'unknown', via };
    // 게이트웨이·검사·공급사·프로필 문제(gateway:*·guard:*·provider:*·questions_digest_mismatch …)는 판정이 아니다
    if (r.reason?.startsWith('gateway:')) s.token = null;
    throw new IntentError('decide.unavailable');
  }

  private chatSession() {
    const t = this.now();
    if (!this.session || t - this.session.lastAt > SESSION_IDLE_MS) this.session = { id: `chat_${randomUUID()}`, lastAt: t, token: null };
    this.session.lastAt = t;
    return this.session;
  }

  /** 마스킹 사전: 거래처(상호·대표자·이메일·사업자번호)와 내 프로필(상호·대표자·사업자번호) */
  private addNames(red: Redactor): void {
    for (const c of new CounterpartyRepo(this.db).list()) {
      red.addRecord({ recordId: `cp:${c.id}`, names: [c.name, ...(c.repName ? [c.repName] : [])], emails: c.email ? [c.email] : [], bizNos: [c.bizNo] });
    }
    for (const p of new ProfileRepo(this.db).list()) {
      red.addRecord({ recordId: `pf:${p.id}`, names: [p.displayName, ...(p.repName ? [p.repName] : [])], bizNos: p.bizNo ? [p.bizNo] : [] });
    }
  }
}

/**
 * 엔진 기본 경로(게이트웨이)로 IntentModel을 만든다. Egress에 게이트웨이 설정(금고 DPoP 서명기)이 없으면 null이다.
 * 그때 intent.resolve는 decide.unavailable이고 main은 연결 안 됨을 보인다.
 */
export function gatewayIntentModel(egress: Egress, opts: { catalog?: BundleCatalog; profiles?: ThresholdProfiles; promoted?: Set<string> } = {}): IntentModel | null {
  if (!egress.gatewayGuard) return null;
  const catalog = opts.catalog ?? BundleCatalog.load();
  const b = catalog.get(INTENT_BUNDLE);
  if (!b) return null;
  const layer = new DefaultModelLayer({ catalog, profiles: opts.profiles ?? ThresholdProfiles.load(), decider: new GatewayDecideAdapter({ egress }) });
  const judge = new Judge(layer, opts.promoted ?? loadPromotions());
  const q = b.def.questions.find((x) => x.name === 'playbook');
  const playbooks = q && q.type === 'choice' ? q.choices.map((c) => c.value).filter((v) => v !== 'none_of_these') : [];
  return { judge, runToken: (chatSessionId) => gatewayRunToken(egress, { chatSessionId }), bundle: { maxInputBytes: b.def.maxInputBytes, playbooks } };
}

/**
 * 실행(IR decide 스텝)용 판정기와 실행마다 받는 게이트웨이 run 토큰(PR-D2). Egress에 게이트웨이 설정이 없으면 null이다.
 * 그때 IR decide 스텝은 decide.unavailable로 멈춘다(모델 없이 화면을 판정하지 않는다).
 */
export function gatewayRunJudge(egress: Egress, opts: { catalog?: BundleCatalog; profiles?: ThresholdProfiles; promoted?: Set<string> } = {}): { judge: Judge; runTokenFor: (runId: string) => Promise<RunToken> } | null {
  if (!egress.gatewayGuard) return null;
  const catalog = opts.catalog ?? BundleCatalog.load();
  const layer = new DefaultModelLayer({ catalog, profiles: opts.profiles ?? ThresholdProfiles.load(), decider: new GatewayDecideAdapter({ egress }) });
  return { judge: new Judge(layer, opts.promoted ?? loadPromotions()), runTokenFor: (runId) => gatewayRunToken(egress, { runId }) };
}
