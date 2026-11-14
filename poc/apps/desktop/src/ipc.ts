// IPC 라우터(M4-1, D01 §2.1, D11 §4 IPC 행): 프로세스 사이 채널 이름과 렌더러 요청 모양을 한곳에 둔다.
// - renderer → main: 호출 채널 하나(IPC.call, invoke). main → renderer: 이벤트 채널 하나(IPC.event, ShellEvent). preload는 이 둘만 연다.
// - main → 창 preload: 포트 넘김 채널(IPC.secretPort 비밀 입력 창, IPC.docparsePort docparse 샌드박스). main은 포트 내용을 보지 않는다.
// - main ↔ engine: 중계 통로(엔진 parentPort, @sax/engine/protocol READ_QUERIES·COMMANDS)와 게이트 포트(GatePortMessage, answerGate 하나). engine-host.ts.
// - main ↔ vault: control 포트(rpc 답 + VaultControlEvent 알림)와 비밀 입력 포트(창 직결, 결속값과 함께). engine-host.ts.
// 렌더러 요청은 SHELL_METHODS 표로 검사한다: 표에 없는 메서드는 unknown_method, 표에 없는 필드·틀린 형·넘친 길이는 bad_request.
// JSON Schema 정본(design/schemas/ipc/renderer-request.schema.json)이 나오기 전의 "수신부 열거형·필수 필드 검사"다(D-48(N-77)).
// Electron 값은 타입으로만 받는다(node --test로 시험, tests/shell-ipc.test.ts).
import type { WebFrameMain } from 'electron';
import { PACK_SHELL_METHODS } from './accountant-pack.ts';
import { BANK_SHELL_METHODS } from './bank-ipc.ts';
import { BIZ_FIELD_KEYS, BIZ_FIELD_MAX, ONB_ALL_CHOICES, ONB_STEPS, ONB_TASKS } from './onboarding.ts';

export type { GatePortMessage, GateRequest, LocalApproval } from '@sax/engine/gate';
export type { EngineInit, EnginePortal } from '@sax/engine/protocol';
// main ↔ 금고 계약(#42). 값은 금고 프로토콜이 정본이고 main은 타입으로만 받는다.
export type { ConsentRecord, OneShotBind, ProfileScope, RunBeginParams, SecretInputBind, SecretStoreResult, StoreBind, VaultEventName } from '@sax/vault';
import type { ProfileScope, VaultEventName } from '@sax/vault';

/** 채널 이름. preload(.cjs)는 이 파일을 불러올 수 없어 글자를 그대로 쓴다(tests/shell-ipc.test.ts가 맞춰 본다). */
export const IPC = {
  call: 'sax',
  event: 'sax:event',
  secretPort: 'vault-secret-port',
  docparsePort: 'docparse-port',
} as const;

/** 금고 control 포트로 main에 오는 알림(secret.needed·진행 안내 등). 판단은 받는 쪽이 main 내장 표로 한다. */
export interface VaultControlEvent {
  t: 'ev';
  name: VaultEventName;
  data: unknown;
}

// ---- 렌더러 요청 표 ----

type Opt = { required?: false };
type Req = { required: true };
export type FieldSpec =
  | ({ t: 'string'; max: number; nullable?: boolean } & (Opt | Req))
  | ({ t: 'number' } & (Opt | Req))
  | ({ t: 'boolean' } & (Opt | Req))
  | ({ t: 'enum'; of: readonly string[]; nullable?: boolean } & (Opt | Req))
  | ({ t: 'object'; fields: Readonly<Record<string, FieldSpec>> } & (Opt | Req));
export type MethodSpec = Readonly<Record<string, FieldSpec>>;

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
/** 표의 필드 정의에서 처리기 인자 형을 만든다(required가 아닌 필드는 없을 수 있다). */
export type ParamsOf<S> = Simplify<{ [K in RequiredKeys<S>]: ValueOf<S[K]> } & { [K in Exclude<keyof S, RequiredKeys<S>>]?: ValueOf<S[K]> }>;

/** 서류·실행·후보 id. 렌더러가 받은 id를 그대로 돌려보낸다. */
const ID = { t: 'string', max: 128, required: true } as const;
const DOC_FIELDS = {
  docType: { t: 'string', max: 64, nullable: true },
  issuedOn: { t: 'string', max: 32, nullable: true },
  expiresOn: { t: 'string', max: 32, nullable: true },
} as const;
/** 온보딩 답(08 §4). 사업자 칸은 비밀이 아니다. 비밀(홈택스 비밀번호·보안카드)은 이 길로 오지 않는다(금고 창 → 금고). */
const ONB_BIZ_MAX = BIZ_FIELD_MAX;
const ONB_ANSWER = {
  step: { t: 'enum', of: ONB_STEPS.filter((x) => x !== 'done'), required: true },
  choice: { t: 'enum', of: ONB_ALL_CHOICES, required: true },
  fields: { t: 'object', fields: Object.fromEntries(BIZ_FIELD_KEYS.map((k) => [k, { t: 'string', max: ONB_BIZ_MAX[k] }])) as Record<(typeof BIZ_FIELD_KEYS)[number], { t: 'string'; max: number }> },
  certId: { t: 'string', max: 64 },
  tasks: { t: 'object', fields: Object.fromEntries(ONB_TASKS.map((x) => [x.id, { t: 'boolean' }])) as Record<string, { t: 'boolean' }> },
} as const;
const G24_DOC = { t: 'enum', of: ['주민등록표 등본', '주민등록표 초본'], required: true } as const;

/**
 * 셸 렌더러가 부를 수 있는 메서드 전부. 승인·게이트·바 숨김 경로는 여기에 없다(ADR-021, tests/h01-guards).
 * 길이 상한은 넘치면 거부하는 상한이다(처리기는 화면에 맞는 길이로 다시 자른다).
 */
export const SHELL_METHODS = {
  'shell.bootstrap': {},
  'profile.set': { kind: { t: 'enum', of: ['business', 'personal'] satisfies ProfileScope[], required: true } },
  'request.send': { text: { t: 'string', max: 10_000, required: true }, vat: { t: 'enum', of: ['separate', 'included'], nullable: true } },
  // 초안 카드에서 고치기: 부가세·금액·품목·받는 이메일(품목은 엔진 상한 100자, 넘치면 거부)
  'run.redraft': { id: ID },
  'draft.update': { id: ID, vat: { t: 'enum', of: ['separate', 'included'] }, amount: { t: 'number' }, amountText: { t: 'string', max: 200 }, item: { t: 'string', max: 200 }, email: { t: 'string', max: 320 }, counterpartyId: { t: 'string', max: 128 } },
  'run.prepare': { id: ID },
  'run.stop': { id: ID },
  // 핸드오프 [다 했어요]·[직접 발급함](D03 §2 HandedOff). 재개·확인으로만 가고 발급하지 않는다(엔진이 원장에 observed_manual을 쓴다).
  'run.resume': { id: ID },
  'run.manualDone': { id: ID },
  'run.showBrowser': { id: ID },
  // [브라우저] 토글(대표 지시 2026-11-13 "claude desktop처럼"): show면 실행 Chrome을 앱 브라우저 패널 자리에 맞춰 앞으로, 아니면 앱을 앞으로.
  'browser.toggle': { show: { t: 'boolean', required: true } },
  // 앱 패널 안 브라우저 조작(대표 지시 2026-11-13 "인앱 브라우저에서 조작"): 패널 위 마우스·키·글자. 좌표는 프레임 기준 0~1.
  // main은 메인 창에서 방금 본 실제 입력(마우스·키)이 있을 때만 금고 screen.input으로 넘긴다.
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
  // 앱 안 브라우저(embedded-browser.ts): 패널 화면 칸 자리(창 콘텐츠 DIP, none이면 숨김)와 경계 끌기 폭. main이 패널 영역·범위로 자른다.
  'browser.slot': { none: { t: 'boolean' }, x: { t: 'number' }, y: { t: 'number' }, width: { t: 'number' }, height: { t: 'number' } },
  'browser.resize': { width: { t: 'number', required: true } },
  // Chrome 설치 안내의 [다시 확인](U6): 설치돼 있는지 다시 보고 판을 새로 보낸다. 읽기만 한다.
  'chrome.check': {},
  // 보안 프로그램(MagicLine4NX) 점검·설치 파일 열기·켜기(B4). 설치·켜기는 실제 입력 뒤에만.
  'security.check': {},
  'security.install': {},
  'security.start': {},
  // 기억한 인증서 비밀번호(대표 지시 2026-11-13): 있는지만 보고, 설정의 [지우기]로 지운다. 값은 오가지 않는다.
  'certMemory.status': {},
  'certMemory.forget': {},
  // 설정에서 인증서 비밀번호 저장(가려진 칸, 금고로만). 값은 로그·상태에 남기지 않는다.
  'certMemory.save': { value: { t: 'string', max: 256, required: true } },
  // 보안카드 등록(부장 판정 2026-11-14): 금고 직결 등록 창을 연다. 사진·칸 값은 이 길로 오지 않는다(창 → 금고 포트). onboarding이면 저장 뒤 main이 인증을 정한다. 실제 입력 뒤에만.
  'card.status': {},
  'card.register': { onboarding: { t: 'boolean' } },
  'card.forget': {},
  // 대화 비밀 입력 카드의 답(대표 지시 2026-11-14): 값 또는 취소. main이 금고 1회용 포트로만 넘긴다.
  'secret.answer': { reqId: { t: 'string', max: 40, required: true }, value: { t: 'string', max: 256 }, cancel: { t: 'boolean' } },
  // 기억한 홈택스 인증서 이름(profiles.cert_name): 보기(이름 부분만)·지우기(B4, H-01 2.3.0). 지우기는 실제 입력 뒤에만.
  'certName.status': {},
  'certName.clear': {},
  // InDoubt 카드(직접 확인 안내)를 열고 닫음. main은 이것으로 증언 바를 띄우고 내린다(ADR-021 결정 5). 증언 자체는 바 클릭으로만 받는다.
  'incident.open': { id: ID },
  'incident.close': { id: ID },
  'docs.list': {},
  // 발급한 세금계산서(B5 문서함): 원장·실행 이력(db.query.runs.history)을 지금 읽어 한 줄씩. 읽기만 한다.
  'issued.list': {},
  // 열기 암호 길이 판정(password_too_long)은 가져오기 쪽이 한다. 여기 상한은 그보다 넉넉하다.
  'docs.import': { pick: { t: 'boolean' }, pickId: { t: 'string', max: 128 }, password: { t: 'string', max: 4096 } },
  // 렌더러는 늘 열기 암호를 묻던 pickId를 보낸다. 빈 호출은 받지 않는다.
  'docs.importCancel': { pickId: { t: 'string', max: 128, required: true } },
  'docs.update': { id: ID, patch: { t: 'object', fields: DOC_FIELDS }, seen: { t: 'object', fields: DOC_FIELDS } },
  'docs.open': { id: ID },
  // 같은 파일을 파일 관리자에서 보여 준다(결과 카드 [폴더 열기], #32).
  'docs.reveal': { id: ID },
  'counterparties.list': {},
  // 내 사업장 화면을 열 때 장부를 다시 읽는다(실행이 홈택스 화면에서 채운 칸).
  'profiles.list': {},
  // 거래처 추가·수정(#32, M4-3). id가 null이면 새 거래처. 폼 값은 FormData.get이라 null일 수 있다. 발급 인증 기본 바꾸기는 시연 DB에서만(fixture).
  'counterparty.save': {
    id: { t: 'string', max: 128, nullable: true },
    name: { t: 'string', max: 200, nullable: true },
    bizNo: { t: 'string', max: 40, nullable: true },
    rep: { t: 'string', max: 100, nullable: true },
    email: { t: 'string', max: 320, nullable: true },
    item: { t: 'string', max: 200, nullable: true },
    // [등록증으로 채우기]가 돌려준 읽기 표(값 없음). OCR이 번호를 잘못 읽어 비운 칸에 사용자가 번호를 넣었을 때 같은 읽기의 주소를 붙인다.
    certHold: { t: 'string', max: 64, nullable: true },
  },
  // [등록증으로 채우기](M4-3 O-05): 파일 고르기 → 후보(상호·번호·대표자). 인자 없음.
  'counterparty.readCert': {},
  'g24.candidates': { doc: G24_DOC, startedAt: { t: 'number', required: true } },
  'g24.save': { id: ID, doc: G24_DOC },
  'clipboard.copy': { text: { t: 'string', max: 2000, required: true } },
  // 계정 로그인(A-01, remote-account.ts). 코드 보내기·확인은 실제 입력 뒤에만(USER_ACTION_METHODS).
  'account.view': {},
  // signup: 계정 만들기 화면에서 보냈다(코드 확인 뒤 비밀번호가 없으면 만들기 단계, 인계 명세 §3).
  'account.sendCode': { email: { t: 'string', max: 254, required: true }, signup: { t: 'boolean' } },
  'account.verify': { code: { t: 'string', max: 6, required: true } },
  'account.back': {},
  // 설정 > 계정 [로그아웃](실제 입력 뒤에만). 인자 없음.
  'account.signOut': {},
  // 비밀번호 로그인(ADR-038). 비밀번호는 renderer → main → 계정 서비스로만 간다(로그·디스크·금고에 두지 않는다).
  'account.password': { email: { t: 'string', max: 254, required: true }, password: { t: 'string', max: 512, required: true } },
  // 계정 만들기의 비밀번호 단계(PUT /v1/password). 비밀번호는 같은 규칙(로그·디스크·금고 없음). [나중에]는 인자 없음.
  'account.setPassword': { password: { t: 'string', max: 512, required: true } },
  'account.skipPassword': {},
  // 비밀번호 찾기(인계 명세 §4). 코드 받기는 이메일 하나, 바꾸기는 코드 6자리 + 새 비밀번호(같은 규칙: 로그·디스크·금고 없음).
  'account.startReset': { email: { t: 'string', max: 254, required: true } },
  'account.finishReset': { code: { t: 'string', max: 6, required: true }, password: { t: 'string', max: 512, required: true } },
  // 폰 연결 창 열기(S-03). 인자 없음. 실제 입력 뒤에만.
  'pair.open': {},
  // 온보딩 답 하나(O-01~O-06·동의 4종). 동의는 화면마다 명시 클릭이라 실제 입력 뒤에만 받는다(USER_ACTION_METHODS).
  'onboarding.reply': ONB_ANSWER,
  // 끝낸 온보딩에서 건너뛴 사업자·인증을 다시 연다([사업자 등록 마치기]·[발급 인증 고르기]). 실제 입력 뒤에만.
  'onboarding.reopen': { item: { t: 'enum', of: ['biz', 'auth'], required: true } },
  // 내 사업장(D-03) 고치기(profile-edit.ts). 칸 상한은 온보딩 O-02와 같다. confirmUnverified: 번호를 조회하지 못해 [맞습니다]를 눌렀다.
  'profile.edit': { fields: { t: 'object', required: true, fields: ONB_ANSWER.fields.fields }, confirmUnverified: { t: 'boolean' } },
  // 내 사업장 [파일에서 읽기]: 등록증 파일 고르기 → 칸 후보. 인자 없음.
  'profile.readCert': {},
  // 계좌 자동조회(CODEF 공동인증서, bank-auto.ts). 비밀번호·계좌번호는 이 길로 오지 않는다(비밀번호는 금고 창, 계좌는 끝 4자리·고르기 열쇠만).
  'bankAuto.status': {},
  'bankAuto.certs': {},
  'bankAuto.consent': { version: { t: 'string', max: 64, required: true } },
  'bankAuto.connect': { certId: { t: 'string', max: 64, required: true }, bank: { t: 'enum', of: ['0020', '0004', '0088', '0081', '0003', '0011'] }, clientType: { t: 'enum', of: ['B', 'P'] } },
  'bankAuto.choose': { sessionId: { t: 'string', max: 64, required: true }, key: { t: 'string', max: 8, required: true }, alias: { t: 'string', max: 40 } },
  'bankAuto.refresh': {},
  'bankAuto.cancel': {},
  'bankAuto.disconnect': {},
  // 받을 돈(09 D-09, bank-ipc.ts). 파일 고르기 둘(bank.pickStatement·pickInvoices)은 실제 입력 뒤에만.
  ...BANK_SHELL_METHODS,
  // 세무사 꾸러미(accountant-pack.ts): 만들기(로컬 폴더·zip), Finder에서 보기, 공유 시트. 보기·공유는 실제 입력 뒤에만.
  ...PACK_SHELL_METHODS,
} as const satisfies Record<string, MethodSpec>;

export type ShellMethod = keyof typeof SHELL_METHODS;
/** 셸 처리기 표의 형. 표와 처리기의 키가 어긋나면 컴파일되지 않는다. */
export type ShellHandlers = { [M in ShellMethod]: (p: ParamsOf<(typeof SHELL_METHODS)[M]>) => unknown };

/**
 * 렌더러 발 사용자 동작 명령(D11 §4 IPC 행, ADR-027 결정 8): main이 메인 창에서 직접 본 실제 입력 뒤 ms 안에만 받는다.
 * 처리기가 needGesture(ms)를 부른다(docs.import는 파일 고르기를 열 때만). tests/shell-harden.test.ts가 처리기 소스와 맞춰 본다.
 */
export const USER_ACTION_METHODS: Readonly<Partial<Record<ShellMethod, number>>> = { 'run.prepare': 2_000, 'docs.import': 3_000, 'docs.open': 3_000, 'docs.reveal': 3_000, 'onboarding.reply': 3_000, 'onboarding.reopen': 3_000, 'profile.edit': 3_000, 'profile.readCert': 3_000, 'counterparty.readCert': 3_000, 'account.sendCode': 3_000, 'account.verify': 3_000, 'account.password': 3_000, 'account.setPassword': 3_000, 'account.startReset': 3_000, 'account.finishReset': 3_000, 'account.signOut': 3_000, 'pair.open': 3_000, 'run.resume': 3_000, 'run.manualDone': 3_000, 'incident.open': 3_000, 'bankAuto.consent': 3_000, 'bankAuto.connect': 3_000, 'bankAuto.choose': 3_000, 'bankAuto.refresh': 3_000, 'bankAuto.disconnect': 3_000, 'run.showBrowser': 3_000, 'browser.toggle': 3_000, 'certName.clear': 3_000, 'certMemory.save': 3_000, 'secret.answer': 3_000, 'security.install': 3_000, 'security.start': 3_000, 'bank.pickStatement': 3_000, 'bank.pickInvoices': 3_000, 'bank.refresh': 3_000, 'pack.reveal': 3_000, 'pack.share': 3_000 };

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

/** 표에 없는 필드가 있거나, 필수 필드가 없거나, 형이 틀리면 false. undefined 값은 없는 필드로 본다. */
export function checkParams(spec: MethodSpec, params: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const f = Object.hasOwn(spec, k) ? spec[k] : undefined;
    if (!f || !checkField(f, v)) return false;
  }
  for (const [k, f] of Object.entries(spec)) if (f.required && params[k] === undefined) return false;
  return true;
}

/** 렌더러 요청 하나를 검사한다. 메서드가 표에 없으면 unknown_method(모양보다 먼저), 모양이 틀리면 bad_request. */
export function parseRendererRequest<T extends Record<string, MethodSpec>>(methods: T, req: unknown): { method: keyof T & string; params: Record<string, unknown> } {
  if (!isPlain(req) || typeof req.method !== 'string') throw new Error('bad_request');
  const method = req.method;
  if (!Object.hasOwn(methods, method)) throw new Error('unknown_method');
  const params = req.params ?? {};
  if (!isPlain(params) || !checkParams(methods[method]!, params)) throw new Error('bad_request');
  return { method, params };
}

/** 보낸 프레임이 그 페이지의 최상위 프레임인지(iframe에 같은 페이지를 넣어 부르는 길을 막는다). */
export function isTopFrame(frame: Pick<WebFrameMain, 'url' | 'parent'> | null | undefined, url: string): boolean {
  return !!frame && frame.url === url && frame.parent === null;
}

/**
 * 셸 요청 처리: 최상위 프레임 확인 → 표 검사 → 처리기. 보낸 창(e.sender) 확인은 부르는 쪽이 먼저 한다(창마다 다르다).
 * 처리기 오류는 그대로 던진다(코드만 담는 것은 처리기 몫).
 */
export async function dispatchShell(frame: Pick<WebFrameMain, 'url' | 'parent'> | null | undefined, url: string, handlers: ShellHandlers, req: unknown): Promise<unknown> {
  if (!isTopFrame(frame, url)) throw new Error('forbidden');
  const { method, params } = parseRendererRequest(SHELL_METHODS, req);
  return (handlers[method] as (p: Record<string, unknown>) => unknown)(params);
}

// ---- main → renderer 이벤트 ----

/** 렌더러에 보내는 이벤트 전부. 카드 내용·좌표·승인 근거는 보내지 않는다(자리 비우기용 띠 여부·높이만, ADR-021 결정 7). */
export type ShellEvent =
  | { type: 'bar'; active: true; band: boolean; height: number }
  | { type: 'bar'; active: false; reason: string }
  | { type: 'bar-layout'; band: boolean; height: number }
  | { type: 'run'; run: unknown }
  /** 대화 비밀 입력 카드(값 없음): open이면 카드를 띄우고, done·closed면 카드를 닫는다. */
  | { type: 'secretAsk'; reqId: string; state: 'open' | 'done' | 'closed'; runId?: string; kind?: string; label?: string; note?: string }
  // 진행 화면(B3): 실행 탭 화면 한 장(jpeg data URL, 보기 전용, 옛 Chrome 길) · 주소·제목 · 비밀 창 동안 멈춤 · 실행 끝
  | { type: 'screen'; runId: string; frame?: string; w?: number; h?: number; url?: string; title?: string; paused?: boolean; ended?: boolean; gone?: boolean }
  /** [브라우저] 토글 상태: 패널 크게, 실행 브라우저가 있나. 앱 안 브라우저면 embedded와 main이 정한 패널 폭. */
  | { type: 'browser'; shown: boolean; available: boolean; focus?: boolean; embedded?: boolean; width?: number }
  | { type: 'doc'; doc: unknown }
  | { type: 'docs-reload' }
  | { type: 'board'; board: unknown }
  | { type: 'onboarding'; onboarding: unknown }
  | { type: 'account'; account: unknown }
  /** 대화 에이전트 진행 단계(생각 중·장부 보는 중·카드 만드는 중). 문장·값은 싣지 않는다. */
  | { type: 'chat-progress'; phase: 'thinking' | 'reading' | 'drafting' }
  /** 계좌 자동조회 진행(phase·실패 코드·새 줄 수만) */
  | { type: 'bankAuto'; event: unknown }
  /** 창이 앞으로 왔고 그때 커서가 창 안이었다(창 내용 좌표). 렌더러는 그 자리 버튼의 클릭이 오지 않으면 "한 번 더 눌러 주세요"(F-11). */
  | { type: 'activated'; x: number; y: number };
