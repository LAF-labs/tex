import { randomUUID } from 'node:crypto';
import { CounterpartyRepo, ProfileRepo, type Db } from '@sax/db';
import { BundleCatalog, CHAT_REPLY, DefaultModelLayer, GatewayDecideAdapter, L1_MODEL, OpenAIResponsesAdapter, ThresholdProfiles, gatewayRunToken, type DecideResult, type RunToken } from '@sax/model';
import type { Egress } from '@sax/net';
import { CHAT_MAP_IDLE_MS, Redactor } from '@sax/redaction';
import { Judge } from './l0/judge.ts';
import { loadPromotions } from './l0/promotion.ts';
import { CHAT_INPUT_MAX_BYTES, ChatError, chatRespond, chatSecretShaped, type ChatModel, type ChatReply } from './chat.ts';

export const INTENT_BUNDLE = 'intent_route_v1';
/** 입력창 문장 상한(계약 ≤ 2000자) */
export const INTENT_TEXT_MAX = 2000;
const ADVICE_GTE = 0.75;
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
  runToken: (chatSessionId: string) => Promise<RunToken>;
  bundle: { maxInputBytes: number; playbooks: readonly string[] };
  chat?: ChatModel;
}

export interface IntentResolverOptions {
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

  async handle(method: string, p: Record<string, unknown>): Promise<IntentResolution | ChatReply> {
    if (method !== 'intent.resolve' && method !== 'chat.respond') throw new IntentError('unknown_method');
    const text = p?.text;
    if (typeof text !== 'string' || !text.trim() || [...text].length > INTENT_TEXT_MAX) throw new IntentError('bad_text');
    return method === 'chat.respond' ? this.chat(text) : this.resolve(text);
  }

  private async chat(text: string): Promise<ChatReply> {
    const chat = this.opts.model?.chat;
    if (!chat) throw new ChatError('chat.unavailable');
    if (chatSecretShaped(text)) throw new ChatError('chat.secret_rejected');
    const s = this.chatSession();
    let input;
    try {
      const red = new Redactor({ chatSessionId: s.id });
      this.addNames(red);
      input = red.apply(text, { frame: 'none' }).redacted;
    } catch {
      throw new ChatError('chat.unavailable');
    }
    if (Buffer.byteLength(input, 'utf8') > CHAT_INPUT_MAX_BYTES) throw new ChatError('chat.input_too_large');
    try {
      s.token ??= await this.opts.model!.runToken(s.id);
    } catch {
      s.token = null;
      throw new ChatError('chat.unavailable');
    }
    try {
      return await chatRespond(chat, input, s.token, s.id);
    } catch (e) {
      if (e instanceof ChatError && e.code === 'chat.unavailable') s.token = null;
      throw e;
    }
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
      const adviceMentioned = advice?.type === 'predicate' ? advice.probability >= ADVICE_GTE : true;
      return { outcome: 'route', playbook, adviceMentioned, via: a?.source === 'l0' ? 'l0' : 'model' };
    }
    if (r.outcome === 'refuse_advice') {
      if (r.l0Only) throw new IntentError('decide.unavailable');
      return { outcome: 'refuse_advice', via: 'model' };
    }
    if (r.outcome === 'unknown' && r.reason && UNCERTAIN.has(r.reason)) return { outcome: 'unknown', via };
    if (r.reason?.startsWith('gateway:')) s.token = null;
    throw new IntentError('decide.unavailable');
  }

  private chatSession() {
    const t = this.now();
    if (!this.session || t - this.session.lastAt > CHAT_MAP_IDLE_MS) this.session = { id: `chat_${randomUUID()}`, lastAt: t, token: null };
    this.session.lastAt = t;
    return this.session;
  }

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
  const layer = new DefaultModelLayer({ catalog, profiles: opts.profiles ?? ThresholdProfiles.load(), decider: new GatewayDecideAdapter({ egress, model: L1_MODEL }) });
  const judge = new Judge(layer, opts.promoted ?? loadPromotions());
  const q = b.def.questions.find((x) => x.name === 'playbook');
  const playbooks = q && q.type === 'choice' ? q.choices.map((c) => c.value).filter((v) => v !== 'none_of_these') : [];
  const responder = new OpenAIResponsesAdapter({ transport: 'gateway', egress });
  const chat: ChatModel = { respond: (req) => responder.respond(CHAT_REPLY, req) };
  return { judge, runToken: (chatSessionId) => gatewayRunToken(egress, { chatSessionId }), bundle: { maxInputBytes: b.def.maxInputBytes, playbooks }, chat };
}

/**
 * 실행(IR decide 스텝)용 판정기와 실행마다 받는 게이트웨이 run 토큰(PR-D2). Egress에 게이트웨이 설정이 없으면 null이다.
 * 그때 IR decide 스텝은 decide.unavailable로 멈춘다(모델 없이 화면을 판정하지 않는다).
 */
export function gatewayRunJudge(egress: Egress, opts: { catalog?: BundleCatalog; profiles?: ThresholdProfiles; promoted?: Set<string> } = {}): { judge: Judge; runTokenFor: (runId: string) => Promise<RunToken>; locate: OpenAIResponsesAdapter } | null {
  if (!egress.gatewayGuard) return null;
  const catalog = opts.catalog ?? BundleCatalog.load();
  const layer = new DefaultModelLayer({ catalog, profiles: opts.profiles ?? ThresholdProfiles.load(), decider: new GatewayDecideAdapter({ egress, model: L1_MODEL }) });
  return { judge: new Judge(layer, opts.promoted ?? loadPromotions()), runTokenFor: (runId) => gatewayRunToken(egress, { runId }), locate: new OpenAIResponsesAdapter({ transport: 'gateway', egress }) };
}
