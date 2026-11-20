import type { WebFrameMain } from 'electron';
import { PACK_SHELL_METHODS } from './accountant-pack.ts';
import { BANK_SHELL_METHODS } from './bank-ipc.ts';
import { BIZ_FIELD_KEYS, BIZ_FIELD_MAX, ONB_ALL_CHOICES, ONB_STEPS, ONB_TASKS } from './onboarding.ts';

export type { GatePortMessage, GateRequest, LocalApproval } from '@sax/engine/gate';
export type { EngineInit, EnginePortal } from '@sax/engine/protocol';
export type { ConsentRecord, OneShotBind, ProfileScope, RunBeginParams, SecretInputBind, SecretStoreResult, StoreBind, VaultEventName } from '@sax/vault';
import type { ProfileScope } from '@sax/vault';

export const IPC = {
  call: 'sax',
  event: 'sax:event',
  secretPort: 'vault-secret-port',
  docparsePort: 'docparse-port',
} as const;


type Opt = { required?: false };
type Req = { required: true };
type FieldSpec =
  | ({ t: 'string'; max: number; nullable?: boolean } & (Opt | Req))
  | ({ t: 'number' } & (Opt | Req))
  | ({ t: 'boolean' } & (Opt | Req))
  | ({ t: 'enum'; of: readonly string[]; nullable?: boolean } & (Opt | Req))
  | ({ t: 'object'; fields: Readonly<Record<string, FieldSpec>> } & (Opt | Req));
type MethodSpec = Readonly<Record<string, FieldSpec>>;

type Nul<F> = F extends { nullable: true } ? null : never;
type ValueOf<F> = F extends { t: 'string' }
  ? string | Nul<F>
  : F extends { t: 'number' }
    ? number
    : F extends { t: 'boolean' }
      ? boolean
      : F extends { t: 'enum'; of: readonly (infer E)[] }
        ? E | Nul<F>
        : F extends { t: 'object'; fields: infer O }
          ? ParamsOf<O>
          : never;
type RequiredKeys<S> = { [K in keyof S]: S[K] extends { required: true } ? K : never }[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] };
export type ParamsOf<S> = Simplify<{ [K in RequiredKeys<S>]: ValueOf<S[K]> } & { [K in Exclude<keyof S, RequiredKeys<S>>]?: ValueOf<S[K]> }>;

const ID = { t: 'string', max: 128, required: true } as const;
const DOC_FIELDS = {
  docType: { t: 'string', max: 64, nullable: true },
  issuedOn: { t: 'string', max: 32, nullable: true },
  expiresOn: { t: 'string', max: 32, nullable: true },
} as const;
const ONB_BIZ_MAX = BIZ_FIELD_MAX;
const ONB_ANSWER = {
  step: { t: 'enum', of: ONB_STEPS.filter((x) => x !== 'done'), required: true },
  choice: { t: 'enum', of: ONB_ALL_CHOICES, required: true },
  fields: { t: 'object', fields: Object.fromEntries(BIZ_FIELD_KEYS.map((k) => [k, { t: 'string', max: ONB_BIZ_MAX[k] }])) as Record<(typeof BIZ_FIELD_KEYS)[number], { t: 'string'; max: number }> },
  certId: { t: 'string', max: 64 },
  tasks: { t: 'object', fields: Object.fromEntries(ONB_TASKS.map((x) => [x.id, { t: 'boolean' }])) as Record<string, { t: 'boolean' }> },
} as const;
const G24_DOC = { t: 'enum', of: ['주민등록표 등본', '주민등록표 초본'], required: true } as const;

export const SHELL_METHODS = {
  'shell.bootstrap': {},
  'profile.set': { kind: { t: 'enum', of: ['business', 'personal'] satisfies ProfileScope[], required: true } },
  'request.send': { text: { t: 'string', max: 10_000, required: true }, vat: { t: 'enum', of: ['separate', 'included'], nullable: true } },
  'run.redraft': { id: ID },
  'draft.update': { id: ID, vat: { t: 'enum', of: ['separate', 'included'] }, amount: { t: 'number' }, amountText: { t: 'string', max: 200 }, item: { t: 'string', max: 200 }, email: { t: 'string', max: 320 }, counterpartyId: { t: 'string', max: 128 } },
  'run.prepare': { id: ID },
  'run.stop': { id: ID },
  'run.resume': { id: ID },
  'run.retryCert': { id: ID },
  'run.simpleDone': { id: ID },
  'run.manualDone': { id: ID },
  'run.showBrowser': { id: ID },
  'browser.toggle': { show: { t: 'boolean', required: true } },
  'browser.input': {
    kind: { t: 'enum', of: ['mouse', 'wheel', 'key', 'text'], required: true },
    type: { t: 'enum', of: ['mousePressed', 'mouseReleased', 'mouseMoved'] },
    x: { t: 'number' },
    y: { t: 'number' },
    button: { t: 'enum', of: ['left', 'right'] },
    clickCount: { t: 'number' },
    dx: { t: 'number' },
    dy: { t: 'number' },
    key: { t: 'string', max: 16 },
    text: { t: 'string', max: 2000 },
    modifiers: { t: 'number' },
  },
  'browser.slot': { none: { t: 'boolean' }, x: { t: 'number' }, y: { t: 'number' }, width: { t: 'number' }, height: { t: 'number' } },
  'browser.resize': { width: { t: 'number', required: true } },
  'chrome.check': {},
  'security.check': {},
  'security.install': {},
  'security.start': {},
  'legal.open': { doc: { t: 'enum', of: ['terms', 'privacy'], required: true } },
  'certMemory.status': {},
  'certMemory.forget': {},
  'certMemory.save': { value: { t: 'string', max: 256, required: true } },
  'secret.answer': { reqId: { t: 'string', max: 40, required: true }, value: { t: 'string', max: 256 }, cancel: { t: 'boolean' } },
  'certName.status': {},
  'certName.clear': {},
  'incident.open': { id: ID },
  'incident.close': { id: ID },
  'docs.list': {},
  'issued.list': {},
  'docs.import': { pick: { t: 'boolean' }, pickId: { t: 'string', max: 128 }, password: { t: 'string', max: 4096 } },
  'docs.importCancel': { pickId: { t: 'string', max: 128, required: true } },
  'docs.update': { id: ID, patch: { t: 'object', fields: DOC_FIELDS }, seen: { t: 'object', fields: DOC_FIELDS } },
  'docs.open': { id: ID },
  'docs.reveal': { id: ID },
  'counterparties.list': {},
  'profiles.list': {},
  'counterparty.save': {
    id: { t: 'string', max: 128, nullable: true },
    name: { t: 'string', max: 200, nullable: true },
    bizNo: { t: 'string', max: 40, nullable: true },
    rep: { t: 'string', max: 100, nullable: true },
    email: { t: 'string', max: 320, nullable: true },
    item: { t: 'string', max: 200, nullable: true },
    certHold: { t: 'string', max: 64, nullable: true },
  },
  'counterparty.readCert': {},
  'g24.candidates': { doc: G24_DOC, startedAt: { t: 'number', required: true } },
  'g24.save': { id: ID, doc: G24_DOC },
  'clipboard.copy': { text: { t: 'string', max: 2000, required: true } },
  'account.view': {},
  'account.sendCode': { email: { t: 'string', max: 254, required: true }, signup: { t: 'boolean' } },
  'account.verify': { code: { t: 'string', max: 6, required: true } },
  'account.back': {},
  'account.signOut': {},
  'account.deletion': {},
  'account.delete': {},
  'account.deleteCancel': {},
  'account.password': { email: { t: 'string', max: 254, required: true }, password: { t: 'string', max: 512, required: true } },
  'account.setPassword': { password: { t: 'string', max: 512, required: true } },
  'account.skipPassword': {},
  'account.startReset': { email: { t: 'string', max: 254, required: true } },
  'account.finishReset': { code: { t: 'string', max: 6, required: true }, password: { t: 'string', max: 512, required: true } },
  'pair.open': {},
  'pair.view': {},
  'pair.submit': { code: { t: 'string', max: 6, required: true } },
  'pair.retry': {},
  'pair.cancel': {},
  'devices.list': {},
  'devices.unlink': { deviceId: { t: 'string', max: 36, required: true } },
  'devices.px': { deviceId: { t: 'string', max: 36, required: true }, on: { t: 'boolean', required: true } },
  'devices.leave': {},
  'account.linkAccept': {},
  'account.linkCancel': {},
  'pclink.list': {},
  'pclink.begin': { deviceId: { t: 'string', max: 36, required: true } },
  'pclink.confirm': { deviceId: { t: 'string', max: 36, required: true }, code: { t: 'string', max: 6, required: true } },
  'pclink.reject': { deviceId: { t: 'string', max: 36, required: true } },
  'billing.view': {},
  'billing.subscribe': {},
  'billing.cancel': {},
  'billing.refund': {},
  'onboarding.reply': ONB_ANSWER,
  'onboarding.reopen': { item: { t: 'enum', of: ['biz', 'auth'], required: true } },
  'profile.edit': { fields: { t: 'object', required: true, fields: ONB_ANSWER.fields.fields }, confirmUnverified: { t: 'boolean' } },
  'profile.readCert': {},
  'bankAuto.status': {},
  'bankAuto.certs': {},
  'bankAuto.consent': { version: { t: 'string', max: 64, required: true } },
  'bankAuto.connect': { certId: { t: 'string', max: 64, required: true }, bank: { t: 'enum', of: ['0020', '0004', '0088', '0081', '0003', '0011'] }, clientType: { t: 'enum', of: ['B', 'P'] }, withdrawAccount: { t: 'string', max: 20 } },
  'bankAuto.choose': { sessionId: { t: 'string', max: 64, required: true }, key: { t: 'string', max: 8, required: true }, alias: { t: 'string', max: 40 } },
  'bankAuto.sms': { sessionId: { t: 'string', max: 64, required: true }, code: { t: 'string', max: 8, required: true } },
  'bankAuto.refresh': {},
  'bankAuto.cancel': {},
  'bankAuto.disconnect': {},
  ...BANK_SHELL_METHODS,
  ...PACK_SHELL_METHODS,
} as const satisfies Record<string, MethodSpec>;

export type ShellMethod = keyof typeof SHELL_METHODS;
export type ShellHandlers = { [M in ShellMethod]: (p: ParamsOf<(typeof SHELL_METHODS)[M]>) => unknown };

export const USER_ACTION_METHODS: Readonly<Partial<Record<ShellMethod, number>>> = { 'run.prepare': 2_000, 'docs.import': 3_000, 'docs.open': 3_000, 'docs.reveal': 3_000, 'onboarding.reply': 3_000, 'onboarding.reopen': 3_000, 'profile.edit': 3_000, 'profile.readCert': 3_000, 'counterparty.readCert': 3_000, 'account.sendCode': 3_000, 'account.verify': 3_000, 'account.password': 3_000, 'account.setPassword': 3_000, 'account.startReset': 3_000, 'account.finishReset': 3_000, 'account.signOut': 3_000, 'account.delete': 3_000, 'account.deleteCancel': 3_000, 'pair.open': 3_000, 'pair.submit': 3_000, 'pair.retry': 3_000, 'devices.unlink': 3_000, 'devices.leave': 3_000, 'devices.px': 3_000, 'account.linkAccept': 3_000, 'account.linkCancel': 3_000, 'pclink.begin': 3_000, 'pclink.confirm': 3_000, 'pclink.reject': 3_000, 'billing.subscribe': 3_000, 'billing.cancel': 3_000, 'billing.refund': 3_000, 'run.resume': 3_000, 'run.retryCert': 3_000, 'run.simpleDone': 3_000, 'run.manualDone': 3_000, 'incident.open': 3_000, 'bankAuto.consent': 3_000, 'bankAuto.connect': 3_000, 'bankAuto.choose': 3_000, 'bankAuto.sms': 3_000, 'bankAuto.refresh': 3_000, 'bankAuto.disconnect': 3_000, 'run.showBrowser': 3_000, 'browser.toggle': 3_000, 'certName.clear': 3_000, 'certMemory.save': 3_000, 'secret.answer': 3_000, 'security.install': 3_000, 'security.start': 3_000, 'legal.open': 3_000, 'bank.pickStatement': 3_000, 'bank.pickInvoices': 3_000, 'bank.refresh': 3_000, 'pack.reveal': 3_000, 'pack.share': 3_000 };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function checkField(f: FieldSpec, v: unknown): boolean {
  if (v === null) return (f.t === 'string' || f.t === 'enum') && f.nullable === true;
  switch (f.t) {
    case 'string':
      return typeof v === 'string' && v.length <= f.max;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'string' && f.of.includes(v);
    case 'object':
      return isPlain(v) && checkParams(f.fields, v);
  }
}

export function checkParams(spec: MethodSpec, params: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const f = Object.hasOwn(spec, k) ? spec[k] : undefined;
    if (!f || !checkField(f, v)) return false;
  }
  for (const [k, f] of Object.entries(spec)) if (f.required && params[k] === undefined) return false;
  return true;
}

export function parseRendererRequest<T extends Record<string, MethodSpec>>(methods: T, req: unknown): { method: keyof T & string; params: Record<string, unknown> } {
  if (!isPlain(req) || typeof req.method !== 'string') throw new Error('bad_request');
  const method = req.method;
  if (!Object.hasOwn(methods, method)) throw new Error('unknown_method');
  const params = req.params ?? {};
  if (!isPlain(params) || !checkParams(methods[method]!, params)) throw new Error('bad_request');
  return { method, params };
}

export function isTopFrame(frame: Pick<WebFrameMain, 'url' | 'parent'> | null | undefined, url: string): boolean {
  return !!frame && frame.url === url && frame.parent === null;
}

export async function dispatchShell(frame: Pick<WebFrameMain, 'url' | 'parent'> | null | undefined, url: string, handlers: ShellHandlers, req: unknown): Promise<unknown> {
  if (!isTopFrame(frame, url)) throw new Error('forbidden');
  const { method, params } = parseRendererRequest(SHELL_METHODS, req);
  return (handlers[method] as (p: Record<string, unknown>) => unknown)(params);
}

export type ShellEvent =
  | { type: 'bar'; active: true; band: boolean; height: number }
  | { type: 'bar'; active: false; reason: string }
  | { type: 'bar-layout'; band: boolean; height: number }
  | { type: 'run'; run: unknown }
  | { type: 'secretAsk'; reqId: string; state: 'open' | 'done' | 'closed'; runId?: string; kind?: string; label?: string; note?: string }
  | { type: 'screen'; runId: string; frame?: string; w?: number; h?: number; url?: string; title?: string; paused?: boolean; ended?: boolean; gone?: boolean }
  | { type: 'browser'; shown: boolean; available: boolean; focus?: boolean; embedded?: boolean; width?: number }
  | { type: 'doc'; doc: unknown }
  | { type: 'docs-reload' }
  | { type: 'past'; past: unknown[] }
  | { type: 'board'; board: unknown }
  | { type: 'onboarding'; onboarding: unknown }
  | { type: 'account'; account: unknown }
  | { type: 'pair'; pair: unknown }
  | { type: 'chat-progress'; phase: 'thinking' | 'reading' | 'drafting' }
  | { type: 'chat-reaction'; reaction: 'thumbs_up' | 'eyes' | 'check' | 'pray' }
  | { type: 'open-screen'; screen: string }
  | { type: 'bankAuto'; event: unknown }
  | { type: 'activated'; x: number; y: number }
  | { type: 'open'; to: 'run'; id: string }
  | { type: 'say'; text: string };
