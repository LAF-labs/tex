import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { attestSelfCheck, gateSelfCheck, type AttestRequest, type GateRequest } from '@sax/engine/gate';
import { actionText, ISSUED_OR_UNKNOWN, kstToday, summarize } from './approval-gate.ts';
import type { AttestAnswerResult, AttestWithdrawn, EngineHost, GateAnswerResult } from './engine-host.ts';
import { certDocByCode, type CertCode } from './cert-docs.ts';
import { cleanItem, dayOffset, SIGN_LABEL, emptyPending, hm, parseAmount, split, type Counterparty, type Doc, type Drafts, type Pending, type RunView, type StepState, type VatMode } from './shell-model.ts';
import { emailOk } from './onboarding.ts';
import type { ResumeItem } from './run-resume.ts';

// 셸의 발급 실행(PoC-6). 초안은 main이 만들고(요청 해석은 아직 정규식 목업), [홈택스에서 준비]부터는 엔진이 H-01 플레이북을 돈다.
// 실행 단계·승인 대기·발급 확정·승인번호는 엔진 이벤트에서 온다. 게이트 요청은 게이트 포트로 와서 승인 바가 받는다(shell-app).

const PHASES = ['login', 'form', 'input', 'readback', 'gate', 'sign', 'verify', 'mail'] as const;
type Phase = (typeof PHASES)[number];
/** 서류별 단계 이름(엔진 단계 순서 PHASES). 민원증명은 메일 단계가 없고, 승인 뒤가 서명이 아니라 발급(제출)이다. */
const STEP_LABELS: Readonly<Record<RunView['doc'], readonly string[]>> = {
  'H-01': ['홈택스 로그인', '건별발급 화면', '입력', '되읽기', '승인', '전자서명', '발급목록 확인', '메일 전송 확인'],
  cert: ['홈택스 로그인', '민원 신청 화면', '입력', '되읽기', '승인', '발급', '발급 확인'],
};
const stepsOf = (doc: RunView['doc']) => STEP_LABELS[doc].map((label) => ({ label, state: 'todo' as StepState }));

/**
 * 다시 게이트 경고(고정 문구 3종, M4-2 3부 팀장 조건). 엔진이 새 게이트를 열기 전에 이유를 준다(regate 이벤트, 엔진 계약 요청 중).
 * paused: 멈춘(Paused) 실행을 이어 함(토큰은 직렬화하지 않는다, D03 §2) · date_changed: 준비한 날과 KST 날짜가 다름(B-13) · value_changed: 값이 바뀌어 게이트 앞으로 되감음(R-G6·R-G7).
 */
export const REGATE_NOTE = {
  paused: '멈췄던 작업을 이어서 하려면 새로 승인해야 해요. 앞의 승인은 쓰지 않아요.',
  date_changed: '준비한 날과 오늘(한국 시간) 날짜가 달라요. 작성일자를 다시 확인하고 새로 승인해 주세요.',
  value_changed: '홈택스 값을 다시 읽었어요. 바뀐 값으로 새로 승인해야 해요. 앞의 승인은 쓰지 않아요.',
} as const;
export type RegateReason = keyof typeof REGATE_NOTE;
const isRegate = (x: unknown): x is RegateReason => typeof x === 'string' && Object.hasOwn(REGATE_NOTE, x);

/** 핸드오프(HandedOff, D03 §2): 앱이 진행하지 못해 사람에게 넘긴 단계. [다 했어요]·[직접 발급함]은 재개·확인으로만 가고 발급하지 않는다. */
export const HANDOFF_TEXT = '지금 사람이 필요해요';
export const HANDOFF_HINT = '전용 Chrome 창에서 직접 마치면 [다 했어요], 홈택스에서 직접 발급하셨다면 [직접 발급함]을 눌러 주세요.';
/** 사람 차례 한 줄(실화면 기준, 부장 2026-11-12). 실행은 끝나지 않았고 30분 안에 마치지 않으면 멈춘다(run.handoff_timeout). */
export const HANDOFF_LOGIN = { text: '홈택스 창에서 로그인해 주세요', note: '로그인을 마치면 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' };
export const HANDOFF_SIGN = { text: '홈택스 창에서 인증 방법을 고르고 인증서 비밀번호를 직접 넣어 주세요. 끝나면 자동으로 이어집니다', note: '자동으로 넘어가지 않으면 [다 했어요]를 눌러 주세요.' };
export const HANDOFF_SIGN_TTL = { text: HANDOFF_SIGN.text, note: '앱의 비밀번호 창은 시간이 지나 닫혔어요. 홈택스 창에서 직접 넣어 주세요. 자동으로 넘어가지 않으면 [다 했어요]를 눌러 주세요.' };
/**
 * 발급 인증(프로필, 화면 라벨)별 서명 안내(H-01 2.2.0: 엔진이 인증유형 창에서 프로필 값의 항목을 고른다, methodTargets).
 * now: 승인 직후 서명 단계에 들어서면 바로 보이는 할 일(엔진은 끝 표지를 최대 3분 기다린 뒤에야 handoff sign.waiting을 보낸다).
 * turn: 서명 차례 한 줄. 엔진이 항목을 못 골랐으면(값 없음·항목 안 보임) 사람이 고르므로 "고르고"를 넣는다.
 * 공동·금융인증서는 부장 문구(2026-11-12) 그대로. 모르는 값이면 그 문구.
 */
export const SIGN_BY_AUTH: Record<string, { now: string; text: string }> = {
  [SIGN_LABEL.cert]: { now: '홈택스 창에서 인증서 비밀번호를 직접 넣어 주세요', text: HANDOFF_SIGN.text },
  [SIGN_LABEL.simple_auth]: { now: '휴대폰에서 간편인증 요청을 승인해 주세요', text: '홈택스 창에서 간편인증을 고르고 휴대폰에서 승인해 주세요. 끝나면 자동으로 이어집니다' },
  // 보안카드(대표 지시 2026-11-14): 등록한 카드면 금고가 홈택스 보안카드 창에 번호를 넣는다. 차례가 오면 앱이 못 넣었거나 홈택스가 틀렸다고 한 것이다(다시 치지 않는다).
  [SIGN_LABEL.security_card]: { now: '앱이 홈택스 보안카드 창에 번호를 넣고 있어요', text: '보안카드 번호를 앱이 넣지 못했어요. 홈택스 창에서 보안카드 번호를 직접 넣어 주세요. 홈택스가 틀렸다고 했으면 설정에서 카드를 다시 등록해 주세요' },
};
/**
 * 로그인 단계 안내(H-01 2.2.0 s3~s5): 로그아웃 상태면 엔진이 로그인 화면을 열고 사람이 로그인하기를 최대 10분 기다린다.
 * 그 뒤에야 로그인 차례(handoff)가 오므로, 로그인 단계에 있는 동안 할 일을 바로 보인다(이미 로그인돼 있으면 곧 지나간다).
 */
export const LOGIN_NOW = '홈택스 창에 로그인 화면이 보이면 직접 로그인해 주세요. 로그인하면 자동으로 이어집니다';
export const SIGN_NOW_DEFAULT = '홈택스 창에서 인증을 마쳐 주세요';
const signFor = (auth: string | undefined) => (auth && Object.hasOwn(SIGN_BY_AUTH, auth) ? SIGN_BY_AUTH[auth]! : null);
/** 발급 전 단계의 사람 차례 코드별 한 줄(끝 문구 NOTE와 다르다: 실행은 아직 기다린다). */
const HANDOFF_BY_CODE: Record<string, { text: string; note: string }> = {
  // 로그인 단계에서 오면 로그인 차례([이어서])다(엔진은 캡차·추가 인증을 handoff login으로 보낸다)
  'portal.captcha': { text: '홈택스 창에서 자동입력방지 문자를 넣고 로그인해 주세요', note: '마치면 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' },
  // H-01 2.3.0 s4e: 인증서가 여럿인데 프로필 이름(cert_name)으로 못 골랐다. 사람이 한 번 누르면 엔진이 그 이름을 기억한다(패키지 strings cert.pickOne)
  'cert.pick_needed': { text: '홈택스 창의 인증서 목록에서 쓸 인증서를 한 번 눌러 주세요', note: '고른 뒤 [이어서]를 눌러 주세요. 비밀번호는 앱이 넣어요. 다음부터는 이 인증서를 자동으로 골라요.' },
  // H-01 2.3.1 s7e: 공동인증서 로그인이 안 됐다(인증서 없음·비밀번호 틀림·화면 못 찾음). 엔진이 간편인증 화면까지 열어 두고 사람이 앱 안 브라우저에서 마친다.
  'login.simple_auth': { text: '공동인증서로 로그인하지 못했어요. 아래 홈택스 화면에서 간편인증으로 로그인해 주세요', note: '이름·휴대폰 번호를 넣고 휴대폰에서 인증을 승인한 뒤 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' },
  'portal.mfa_pending': { text: '홈택스 창에서 추가 인증을 마치고 로그인해 주세요', note: '마치면 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' },
  'portal.unexpected_page': { text: '홈택스 창의 화면을 확인해 주세요', note: '앱이 이 화면을 알아보지 못했어요. 홈택스 창에서 이 단계를 마친 뒤 [다 했어요], 직접 발급하셨다면 [직접 발급함]을 눌러 주세요.' },
  'step.assert_failed': { text: '홈택스 창의 화면을 확인해 주세요', note: '앱이 이 화면을 알아보지 못했어요. 홈택스 창에서 이 단계를 마친 뒤 [다 했어요], 직접 발급하셨다면 [직접 발급함]을 눌러 주세요.' },
};
/** 사람 차례의 종류와 한 줄(phase·code). 로그인 차례는 로그인 단계에서 온 것(시간 초과 포함), 서명 차례는 sign 단계(sign.waiting·비밀 창 TTL). */
/** 보안카드 서명 차례의 까닭(엔진 sign.card_*). 홈택스가 틀렸다고 했거나 금고에 그 사실을 남기지 못했으면 다시 등록하게 한다. */
const SIGN_CARD: Readonly<Record<string, { text: string; note: string }>> = {
  'sign.card_wrong': { text: '보안카드 번호가 맞지 않다고 홈택스가 알렸어요. 보안카드를 다시 등록해 주세요', note: '같은 번호를 다시 넣지 않았어요(5번 틀리면 카드가 폐기돼요). 이번 서명은 홈택스 창에서 직접 마쳐 주세요. 설정 › 발급 인증에서 보안카드를 다시 등록할 수 있어요.' },
  'sign.card_locked': { text: '홈택스가 보안카드를 쓸 수 없다고 알렸어요', note: '보안카드가 폐기됐거나 정보가 없어요. 가까운 세무서에서 보안카드를 다시 받거나 공동인증서로 바꿔 주세요. 발급 여부는 홈택스 발급목록에서 확인해 주세요.' },
  'sign.card_credential_suspect': { text: '보안카드를 다시 등록해 주세요', note: '지난번에 홈택스가 번호가 틀렸다고 해서 앱이 보안카드 번호를 넣지 않았어요. 설정 › 발급 인증에서 보안카드를 다시 등록해 주세요. 이번 서명은 홈택스 창에서 직접 마쳐 주세요.' },
  'sign.card_suspect_unsaved': { text: '보안카드를 다시 등록해 주세요', note: '홈택스가 번호가 틀렸다고 했는데 그 사실을 금고에 남기지 못했어요. 같은 번호를 다시 넣지 않게 설정 › 발급 인증에서 보안카드를 다시 등록해 주세요. 이번 서명은 홈택스 창에서 직접 마쳐 주세요.' },
};
export function handoffTurn(phase: Phase, code: string | undefined, auth?: string, labels: readonly string[] = STEP_LABELS['H-01']): { kind: 'login' | 'sign' | 'other'; text: string; note: string } {
  if (phase === 'sign' && code && Object.hasOwn(SIGN_CARD, code)) return { kind: 'sign', ...SIGN_CARD[code]! };
  if (phase === 'sign') return { kind: 'sign', ...(code === 'human.ttl_expired' ? HANDOFF_SIGN_TTL : HANDOFF_SIGN), ...(signFor(auth) ? { text: signFor(auth)!.text } : {}) };
  const byCode = code ? HANDOFF_BY_CODE[code] : undefined;
  if (byCode) return { kind: phase === 'login' ? 'login' : 'other', ...byCode };
  if (phase === 'login') return { kind: 'login', ...HANDOFF_LOGIN };
  return { kind: 'other', text: `${HANDOFF_TEXT} · 이 단계는 직접 해 주세요: ${labels[PHASES.indexOf(phase)] ?? ''}`, note: code && NOTE[code] && !/아무것도 발급하지 않았어요/.test(NOTE[code]!) ? NOTE[code]! : HANDOFF_HINT };
}

type EngineEvent =
  | { runId: string; type: 'phase'; phase: Phase; state: 'now' | 'done' | 'attention'; code?: string; attempt?: number }
  | { runId: string; type: 'regate'; reason: RegateReason }
  | { runId: string; type: 'handoff'; phase: Phase; code?: string }
  | { runId: string; type: 'waiting'; reqId: string }
  /** maintenanceUntil(until): portal.maintenance의 점검 끝 시각(ISO 또는 KST 'HH:MM'). 모르면 없다. */
  | { runId: string; type: 'end'; status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string; maintenanceUntil?: string; until?: string }
  /** 금고 비밀 창 차례(엔진 SecretTurnEvent, 값 없음). 실행은 끝나지 않았다: 앱 비밀번호 창이 뜬다. */
  | { runId: string; type: 'secret'; state: 'open' | 'closed'; stepId?: string; why?: string }
  /** 포털 대화상자 문구(엔진 wait for:'dialog'). key는 패키지 strings 키, ok는 기대 문구와 맞음. 화면에 글로만 보인다. */
  | { runId: string; type: 'notice'; stepId?: string; key?: string; text?: string; ok?: boolean }
  /**
   * 실행 상태(엔진 RunEvent, M2-3). end는 종료 상태에서만 오고, InDoubt는 종료가 아니라 state in_doubt로 온다.
   * 증언·조회 뒤 갈래: state running(새 gate.request) | state paused{code:'policy_downgrade'} | end completed_with_issues.
   */
  | { runId: string; type: 'state'; state: RunState; code?: string; portalNotice?: string };

export const RUN_STATES = ['running', 'waiting_gate', 'waiting_human', 'recovering', 'handed_off', 'paused', 'interrupted', 'in_doubt'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** 모르는 화면(ADR-025 결정 3·5): 일반 실패 코드 대신 보이는 문장. */
/** 화면을 알아보지 못해 멈춤(게시본 건조 실행 결과, 부장 2026-11-11): 다시 준비하거나 직접 발급. */
const SCREEN_UNKNOWN_REDO = '홈택스 화면을 알아보지 못했어요. [다시 준비]를 눌러 보거나 홈택스에서 직접 발급해 주세요. 아무것도 발급하지 않았어요.';
const UNKNOWN_SCREEN = '예상한 홈택스 화면이 아니에요. 전용 Chrome 창에 뜬 안내를 확인해 주세요. 아무것도 발급하지 않았어요.';

/** 엔진 결과 코드 → 사용자 문구. 값은 넣지 않는다. */
/** 받은 홈택스 작업 정보(서명 패키지)의 모양이 틀렸을 때. */
const BAD_PACKAGE = '홈택스 작업 정보가 올바르지 않아 시작하지 않았어요. 앱 업데이트 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.';
export const NOTE: Record<string, string> = {
  // 엔진 상태 paused(D03 §2). 정지 하향이면 이 포털 자동 실행이 멈춘 것이다. 이어 하려면 새로 승인해야 한다(REGATE_NOTE.paused).
  policy_downgrade: '앱이 홈택스 자동 실행을 멈춰서 이 건도 여기서 멈췄어요. 이어서 하려면 새로 승인해야 해요.',
  'run.paused': '이 건을 멈췄어요. 이어서 하려면 새로 승인해야 해요.',
  'browser.closed': '브라우저가 닫혔어요. 아무것도 발급하지 않았어요. [다시 시작]을 누르면 같은 내용으로 다시 준비해요.',
  'login.session_assumed': '가짜 페이지라 로그인을 건너뛰었어요',
  'run.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.expired': '승인을 기다리다 시간이 지나 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'assert.supplier_mismatch': '홈택스에 로그인한 사업자가 이 프로필과 달라서 멈췄어요. 아무것도 발급하지 않았어요.',
  'assert.fields_missing': '홈택스 화면에 비어 있는 칸이 있어 멈췄어요. 아무것도 발급하지 않았어요.',
  pre_dispatch_mismatch: '승인한 뒤 홈택스 화면 값이 바뀌어 발급 버튼을 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'step.identity_mismatch': '홈택스 화면이 예상과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'step.target_not_found': UNKNOWN_SCREEN,
  'checkpoint.expect_failed': UNKNOWN_SCREEN,
  'portal.unexpected_page': SCREEN_UNKNOWN_REDO,
  'step.assert_failed': SCREEN_UNKNOWN_REDO,
  // 기다리다 시간 초과(대개 홈택스 로그인 대기). 승인 뒤 단계의 시간 초과는 in_doubt로 따로 온다.
  'step.timeout': '홈택스 로그인을 기다리다 시간이 지났어요. 홈택스 창에서 로그인을 마친 뒤 [다시 준비]를 눌러 주세요. 아무것도 발급하지 않았어요.',
  'step.selector_miss': SCREEN_UNKNOWN_REDO,
  // 인증서 비밀번호(금고 비밀 창 길, B1B2 인계 노트). 지금 2.2.0은 홈택스 창이 직접 알리지만, 금고 창 길이 열리면 엔진이 이 코드로 끝낸다.
  // 승인 뒤라 [다시 준비]가 없고 발급 여부를 단정하지 않는다(발급목록으로 확인).
  'sign.password_wrong': '인증서 비밀번호가 맞지 않았어요. 발급되지 않았는지 홈택스 발급목록에서 확인해 주세요. 다시 발급하기 전에 꼭 확인해 주세요.',
  'sign.password_retry_limit': '비밀번호가 여러 번 틀렸어요. 인증서가 잠기지 않게 멈췄어요. 홈택스에서 직접 확인해 주세요.',
  'human.ttl_expired': '인증서 비밀번호 창이 시간이 지나 닫혔어요. [다시 준비]를 누르면 다시 열어요. 아무것도 발급하지 않았어요.',
  // Chrome이 없으면 금고가 실행 창을 열지 못한다(엔진 CHROME_NOT_INSTALLED_CODE, customer-dist)
  // 사람 차례를 30분 넘게 기다림(#278 run.handoff_timeout). 발급 전이면 end()가 "아무것도 발급하지 않았어요"·[다시 준비]를 붙인다.
  'run.handoff_timeout': '홈택스 창에서 할 일을 30분 동안 기다렸지만 끝나지 않아 멈췄어요.',
  'chrome.not_installed': 'Chrome이 설치돼 있어야 해요. Chrome을 설치한 뒤 [다시 준비]를 눌러 주세요. 아무것도 발급하지 않았어요.',
  'portal.unobservable': '홈택스 화면을 확인하지 못해 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  // 민원증명: 개인사업자(사업자 인증서) 로그인으로 못 여는 화면(납세증명서·소득금액증명 등, 캡처 2026-11-10)
  'portal.personal_login_required': '이 서류는 개인사업자 로그인으로는 뗄 수 없어요. 홈택스에서 로그아웃하고 대표자 개인 인증서로 다시 로그인해 주세요. 아무것도 발급하지 않았어요.',
  // 게이트 앞 readback 대조(D02 §8 s19d·s19f, D16 assert.*): 값은 문구에 넣지 않는다. 승인 카드를 열지 않았다.
  'assert.total_mismatch': '홈택스 화면의 공급가액과 세액을 더한 값이 합계와 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'assert.input_mismatch': '홈택스 화면 값이 준비한 거래처 사업자번호·공급가액·세액·이메일과 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  // H-01 실화면(2.2.0) s13a: 등록번호 [확인]의 홈택스 안내가 "정상적인 사업자번호입니다."가 아니다(휴업·폐업·미등록 등). 안내 문구는 portalNotice로 따로 보인다.
  'counterpart.bizno_rejected': '홈택스가 이 거래처 사업자번호를 정상으로 확인해 주지 않았어요. 아래 홈택스 안내를 확인해 주세요. 아무것도 발급하지 않았어요.',
  'assert.issue_date_mismatch': '홈택스 작성일자가 오늘(한국 시간)과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'vault.leak_suspected': '보안 점검에서 이상이 보여 멈췄어요. 아무것도 발급하지 않았어요. 앱을 다시 시작해 주세요.',
  'step.readback_mismatch': '홈택스 화면 값을 확실히 읽지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'verify.baseline_missing': '홈택스 발급목록을 미리 확인하지 못해 승인을 열지 않았어요.',
  'verify.not_committed': "직전 시도는 '발급 안 됨'으로 판정되었어요. 홈택스 발급목록을 직접 확인한 뒤 다시 준비해 주세요.",
  'verify.unknown': '발급 요청은 보냈지만 발급목록에서 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  in_doubt: '발급 단계에서 멈춰 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  // 예행(엔진 REHEARSAL_DONE): 승인 직전까지 가서 엔진이 스스로 멈췄다.
  'rehearsal.gate_reached': '예행을 마쳤어요. 승인 직전까지 갔고 발급하지 않았어요.',
  // 예행(엔진 REHEARSAL_HANDOFF): 사람 차례가 나서 바로 멈췄다(예행 실패, 이유는 engine.log run.rehearsal_report).
  'rehearsal.handoff': '예행이 사람이 필요한 단계에서 멈췄어요. 발급하지 않았어요.',
  'mail.not_confirmed': '발급은 완료되었어요. 메일 발송은 홈택스 메일발송목록에서 확인해 주세요.',
  selector_placeholder: '홈택스 화면 정보(셀렉터)가 아직 확정되지 않아 시작하지 않았어요.',
  'answer.rejected': '승인을 엔진에 전달하지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'bar.load_failed': '승인 바를 띄우지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'post_commit.error': '발급은 확정됐지만 그 뒤 단계에서 오류가 났어요. 다시 실행하지 말고 홈택스 발급목록에서 확인해 주세요.',
  'engine.exit_before_approval': '엔진이 멈춰 승인 전에 끝났어요. 홈택스에는 아무것도 발급되지 않았어요. 앱을 다시 시작해 주세요.',
  'engine.exit': '엔진이 발급 도중에 멈춰 발급됐는지 모릅니다. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  // 요청률 정책(D03 §7, 코드는 D16 portal.*·policy.*). 숫자·날짜는 보수 모드(시계 역행)에서 바뀌므로 문구에 넣지 않는다.
  'portal.blocked': '홈택스에서 차단·경고 신호(안내 화면, 요청 거부 응답)가 보여 바로 멈췄어요. 그 뒤로 앱은 홈택스에서 아무 동작도 하지 않았고 아무것도 발급하지 않았어요. 홈택스에 직접 접속해 상태를 확인해 주세요.',
  'portal.blocked_in_doubt': '발급 확인 중에 홈택스에서 차단·경고 신호가 보여 멈췄어요. 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  // 발급 뒤 PDF 보관만 실패(H-01 s32 save_pdf). 발급·승인번호는 그대로다(2026-11-11).
  'save_pdf.failed': '발급은 완료되었어요. 발급한 세금계산서 PDF는 받지 못했어요. 홈택스 발급목록에서 확인·인쇄할 수 있어요. 다시 발급하지 마세요.',
  'portal.blocked_after_commit': '발급은 확정됐지만 그 뒤 홈택스에서 차단·경고 신호가 보여 멈췄어요. 다음 발급을 이어가기 전에 홈택스에 직접 접속해 상태를 확인해 주세요.',
  'policy.cooldown': '홈택스 차단·경고 신호가 보여 24시간 동안 홈택스 실행을 쉬어요. 아무것도 발급하지 않았어요.',
  'portal.mfa_pending': '홈택스가 추가 인증을 요구해 멈췄어요. 아무것도 발급하지 않았어요. 홈택스에서 직접 인증한 뒤 다시 준비해 주세요.',
  'portal.extra_auth_repeat': '홈택스 추가 인증이 반복돼 앱이 스스로 멈췄어요(차단 신호는 아니에요). 홈택스에서 직접 인증을 마친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  // 홈택스 시스템 점검(h01 엔진 portal.maintenance). 끝 시각을 알면 end()가 maintenanceNote로 바꾼다.
  'portal.maintenance': '홈택스가 점검 중이에요. 점검이 끝나면 [다시 시작]을 눌러 주세요. 아무것도 발급하지 않았어요.',
  'portal.captcha': '홈택스가 문자 입력(자동입력방지)을 요구했어요. 홈택스 창에서 직접 입력한 뒤 [다시 준비]를 눌러 주세요. 아무것도 발급하지 않았어요.',
  'portal.busy': '홈택스 접속 대기열이 떠서 멈췄어요. 아무것도 발급하지 않았어요. 혼잡이 풀린 뒤 다시 준비해 주세요.',
  'policy.runs_per_day': '오늘 홈택스 실행 횟수 상한에 닿아 시작하지 않았어요.',
  'policy.irreversible_per_day': '오늘 홈택스 발급 건수 상한에 닿아 멈췄어요. 아무것도 발급하지 않았어요. 내일 다시 할 수 있어요.',
  'policy.runs_per_session': '이번 홈택스 로그인으로 할 수 있는 실행 횟수를 다 써서 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.logins_per_day': '오늘 홈택스 로그인 횟수 상한에 닿아 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.actuations_per_run': '한 번의 실행에서 할 수 있는 동작 수를 넘겨 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.wall_clock': '실행 시간 상한을 넘겨 멈췄어요. 아무것도 발급하지 않았어요.',
  // 시작 전 검사(엔진 runs.ts start·H01 러너, 0.1.5 실사용 "멈췄어요(profile_missing)"). 코드는 화면에 보이지 않는다(로그에만).
  profile_missing: '사업자 정보(사업자번호)가 등록되지 않아 시작하지 않았어요. 대화에서 [사업자 등록 마치기]로 등록해 주세요. 아무것도 발급하지 않았어요.',
  counterparty_missing: '거래처 정보를 찾지 못해 시작하지 않았어요. 거래처 화면에서 확인한 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  bad_amount: '금액을 확인하지 못해 시작하지 않았어요. 카드에서 금액을 고친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  item_missing: '품목이 비어 있어 시작하지 않았어요. 아무것도 발급하지 않았어요. 거래처 화면에서 [저장 품목]을 넣거나, 대화에서 같은 요청을 다시 하면 품목을 물어볼게요.',
  'input.missing': '발급에 필요한 값이 비어 있어 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  // 민원증명 신청 값 검사(엔진 cert.ts certInputs): 앱의 신청 값이 받은 작업 정보(패키지 선언)와 맞지 않는다. 사용자가 고칠 것은 없다.
  'cert.input_invalid': '증명서 신청 값(용도·제출처)이 홈택스 작업 정보의 선택지와 맞지 않아 시작하지 않았어요. 앱을 업데이트한 뒤 다시 해 주세요. 아무것도 발급하지 않았어요.',
  'cert.input_unknown': '홈택스 작업 정보가 받지 않는 신청 값이 있어 시작하지 않았어요. 앱을 업데이트한 뒤 다시 해 주세요. 아무것도 발급하지 않았어요.',
  'cert.unknown_doc': '이 증명서를 떼는 홈택스 작업 정보가 없어 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  busy: '다른 작업이 진행 중이라 시작하지 않았어요. 그 작업이 끝난 뒤 다시 준비해 주세요.',
  already_issuing: '이미 발급을 시작한 건이라 다시 시작하지 않았어요.',
  bad_run_id: '이 카드를 시작하지 못했어요. 대화에서 다시 요청해 주세요. 아무것도 발급하지 않았어요.',
  forbidden_channel: '허용되지 않은 경로로 들어온 요청이라 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  'ledger.intent_not_new': '같은 발급 요청을 이미 기록해 다시 시작하지 않았어요. 홈택스 발급목록을 확인해 주세요.',
  'issue.bad_key': '이 발급 요청을 알아보지 못해 시작하지 않았어요. 대화에서 다시 요청해 주세요. 아무것도 발급하지 않았어요.',
  'ledger.issue_committed': '이 세금계산서는 이미 발급됐어요. 다시 발급하지 않았어요.',
  'ledger.issue_open': '이 세금계산서가 발급됐는지 아직 확인 중이라 다시 시작하지 않았어요. 홈택스 발급목록을 확인해 주세요.',
  'login.not_implemented': '고른 발급 인증으로는 아직 홈택스에 로그인할 수 없어요. 내 사업장 화면의 발급 인증 [바꾸기]에서 다른 인증을 골라 주세요. 아무것도 발급하지 않았어요.',
  'package.not_loaded': '홈택스 작업 정보를 아직 받지 못해 시작하지 않았어요. 인터넷 연결을 확인하고 잠시 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'package.load_failed': '홈택스 작업 정보를 확인하지 못해 시작하지 않았어요. 잠시 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'policy.portal_mode_denied': '지금은 서버 설정으로 이 작업을 자동으로 할 수 없어 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  'token.invalid': '실행 확인 값이 맞지 않아 멈췄어요. 아무것도 발급하지 않았어요. 다시 준비해 주세요.',
  'step.commit_shadow': '발급 버튼 주변 화면이 예상과 달라 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'step.fill_mismatch': '홈택스 칸에 넣은 값이 준비한 값과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  // 서명 패키지 IR 검사(ir.*): 사용자가 고칠 것은 없다
  'ir.bad_edge': BAD_PACKAGE,
  'ir.bad_ref': BAD_PACKAGE,
  'ir.no_end': BAD_PACKAGE,
  'ir.gate_without_readback': BAD_PACKAGE,
  'wait.timeout': '홈택스 화면이 제때 뜨지 않아 멈췄어요. 아무것도 발급하지 않았어요. 잠시 뒤 다시 준비해 주세요.',
};
/** 표에 없는 코드(새 코드·내부 오류)는 코드를 보이지 않고 이 문구로. 코드는 로그(main.run_end 등)에만 남는다. in_doubt는 늘 표의 문구라 이 문구를 쓰지 않는다. */
/** 서명 차례에서 [중지]를 눌렀다: 서명이 이미 됐을 수 있어 발급목록을 확인한 뒤 끝낸다. */
export const STOP_AFTER_SIGN_NOTE = '중지를 받았어요. 서명이 됐는지 홈택스 발급목록에서 확인한 뒤 끝낼게요. 다시 발급하지 마세요.';
/** 엔진 명령 응답 {ok:false, code}는 거절이다(코드를 그대로 던져 화면이 사람 말로 바꾼다). 응답 모양이 다르면(옛 엔진) 받아들인 것으로 본다. */
function refused(res: unknown): void {
  if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === false) {
    const c = (res as { code?: unknown }).code;
    throw new Error(typeof c === 'string' && /^[a-z_]+(\.[a-z_]+)*$/.test(c) ? c : 'refused');
  }
}

/** 승인 전 핸드오프 끝(end status handoff, 재개 불가)의 다음 할 일. 실제 발급 첫 단계(s0)에서 이 모양으로 끝난 일이 있었다. */
export const HANDOFF_END_NOTE = '앱이 홈택스에서 이 단계를 이어 가지 못해 멈췄어요. 아무것도 발급하지 않았어요.';
export const HANDOFF_END_NEXT = '[다시 준비]로 처음부터 다시 하거나, [홈택스에서 직접 발급]으로 옆 패널의 값을 보고 직접 발급할 수 있어요.';
export const UNKNOWN_STOP_NOTE = '멈췄어요. 아무것도 발급하지 않았어요. 다시 준비해 보고, 같은 일이 반복되면 앱을 다시 시작해 주세요.';
/** 차단 신호로 끝났는데 발급됐는지 모름(verify 중 신호). */
const BLOCK_CODES = new Set(['portal.blocked', 'policy.cooldown']);
/** in_doubt(발급됐는지 모름)는 코드와 관계없이 중복 위험을 알린다. 코드별 문구는 이 목록만. */
const IN_DOUBT_NOTE = new Set(['verify.unknown', 'engine.exit']);
/** 민원증명 실행에서만 다른 문구(세금계산서·메일·인터넷 연결 안내가 맞지 않는 것). */
const CERT_NOTE: Record<string, string> = {
  'package.not_loaded': '이 증명서를 떼는 홈택스 작업 정보가 아직 이 PC에 없어 시작하지 않았어요. 앱을 업데이트하면 뗄 수 있어요. 아무것도 발급하지 않았어요.',
  'save_pdf.failed': '발급은 완료되었어요. 증명서 PDF는 받지 못했어요. 홈택스 민원증명 발급 내역에서 다시 출력할 수 있어요.',
};
const note = (code?: string, r?: RunView) => (code && ((r?.cert && CERT_NOTE[code]) || NOTE[code])) || UNKNOWN_STOP_NOTE;

/** 중복 카드 문장(ADR-027 UX). 발급 확정 / 발급 여부 모름 / 이전 시도 미발급. */
export const DUP_NOTE = {
  committed: '이 거래와 같은 건이 이미 발급돼 있어요(승인번호 있음). 한 번 더 발급하면 같은 계산서가 2건이 돼요.',
  unknown: '같은 건이 발급됐는지 아직 확인하지 못했어요. 홈택스 발급목록을 먼저 확인해 주세요.',
  notCommitted: '이전 시도는 발급되지 않았어요. 다시 발급하기 전에 홈택스 발급목록을 한 번 확인해 주세요.',
  other: '같은 거래처·금액·날짜·품목의 기록이 있어요. 같은 건을 두 번 발급하는 것이 아닌지 확인해 주세요.',
} as const;

/** 승인 대기 카드에 붙는 중복 경고(D02 §7). 해당하는 것을 모두 둔다(발급 확정 → 모름 → 직전 미발급). 바에는 가장 위험한 하나가 표시된다. */
function dupWarnings(req: GateRequest, text: Record<keyof typeof DUP_NOTE, string> = DUP_NOTE): string[] {
  const f = new Map<string, string>(req.fields.map((x) => [x.fieldKey, x.value]));
  const states = (f.get('$dup.businessKey') ?? '').split(',');
  const out: string[] = [];
  if (states.includes('committed')) out.push(text.committed);
  if (states.some((s) => s !== 'committed' && ISSUED_OR_UNKNOWN.includes(s))) out.push(text.unknown);
  if (f.get('$dup.priorNotCommitted') === 'true') out.push(text.notCommitted);
  if (!out.length && f.has('$dup.businessKey')) out.push(text.other);
  return out;
}
/** 민원증명 중복 문장(업무 키: 같은 날·같은 서류·같은 신청 값, 엔진 certBusinessKey). */
export const CERT_DUP_NOTE: Record<keyof typeof DUP_NOTE, string> = {
  committed: '오늘 같은 서류를 같은 용도로 이미 뗐어요. 한 번 더 떼면 같은 증명서가 하나 더 생겨요.',
  unknown: '오늘 같은 서류가 발급됐는지 아직 확인하지 못했어요. 홈택스 민원증명 발급 내역을 먼저 확인해 주세요.',
  notCommitted: '이전 시도는 발급되지 않았어요.',
  other: '오늘 같은 서류를 같은 용도로 뗀 기록이 있어요.',
};

/** 금고가 전용 Chrome에서 확장을 보고 비밀 창을 거절했다(extension_not_allowed). 확장 ID·개수·경로는 화면에 두지 않는다(금고 로그에만). */
export const EXTENSION_REFUSED_TEXT = 'Chrome 확장이 감지돼 안전을 위해 멈췄어요. 다시 시도해 주세요.';

/** 금고 이벤트(I-2) → 카드 문장. runId가 없으면 진행 중인 실행에 붙인다. 모르는 이벤트는 null. retry면 끝난 카드에 [다시 시도]. */
export function vaultNotice(name: string, data: unknown): { runId?: string; text: string; retry?: 'extension' } | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (name === 'secret.expired') return { runId: typeof d.runId === 'string' ? d.runId : undefined, text: '입력한 비밀번호를 5분 안에 쓰지 않아 지웠어요. 필요할 때 다시 물어볼게요.' };
  if (name === 'secret_window.leak_suspected') return { text: NOTE['vault.leak_suspected']! };
  if (name === 'secret_window.refused') {
    if (d.reason === 'google_signin_detected') return { text: '전용 Chrome에 Google 계정이 로그인돼 있어 비밀번호 창을 열지 않았어요. 전용 Chrome에서 로그아웃한 뒤 다시 준비해 주세요.' };
    if (d.reason === 'extension_not_allowed') return { text: EXTENSION_REFUSED_TEXT, retry: 'extension' };
    return { text: '전용 Chrome 설정이 바뀌어 비밀번호 창을 열지 않았어요. 앱을 다시 시작해 주세요.' };
  }
  return null;
}

/** 엔진·금고 fatal(I-6) → 기동 거부 대화상자 문장. 해당 없으면 null. */
export function fatalText(code: string): string | null {
  if (code === 'vault: db.key_missing' || code === 'vault: vault.keystore_mismatch') return '이 PC의 자격 증명 관리자에서 앱 열쇠를 찾지 못했어요. 기록을 지키려고 앱을 열지 않았어요.';
  if (code.startsWith('engine.env_tampered')) return '개발용 환경 변수가 켜져 있어 앱을 열지 않았어요.';
  return null;
}

/** 포털이 한 말(ADR-025 결정 5): 텍스트만, 200자. 제어문자는 뺀다. 렌더러는 텍스트 노드로만 넣는다. */
/** 포털 대화상자 확인 줄의 앞말(패키지 strings 키 → 사용자 말). 모르는 키는 '홈택스 안내'. */
const NOTICE_LABEL: Record<string, string> = { 'counterpart.bizNoOk': '사업자번호 확인' };
const cleanNotice = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
/** 점검 정지 카드 글(팝업 아님). */
const maintenanceNote = (hm: string) => `홈택스가 점검 중이에요(~${hm}). 끝나면 자동으로 다시 할게요. 아무것도 발급하지 않았어요.`;
const MAINTENANCE_UNKNOWN_NOTE = NOTE['portal.maintenance']!;
const MAINTENANCE_RESTARTED_NOTE = '홈택스 점검이 끝나 같은 내용으로 다시 시작했어요.';
const MAINTENANCE_RESTART_FAILED_NOTE = '홈택스 점검이 끝났지만 바로 시작하지 못했어요. [홈택스에서 준비]를 눌러 주세요.';
const portalNoticeText = (s: string) => `홈택스 안내: “${s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim().slice(0, 200)}”`;

/**
 * InDoubt 증언 카드 문구(ADR-021 결정 5). 고정 상수만 쓴다. 증언은 발급이 아니고, 다시 발급하려면 새로 승인해야 한다.
 * manual: 정지 하향으로 조회 없이 받는 경우(바에도 "직접 확인한 뒤 답해 주세요"가 붙는다).
 */
export const ATTEST_NOTE = {
  ready: '이 안내를 연 동안 대화 아래에 황토색 확인 카드가 떠요. 홈택스 발급목록에 이 건이 없을 때만 누르세요.',
  manual: '지금은 앱이 발급목록을 조회할 수 없어요. 홈택스 발급목록을 직접 확인한 뒤 황토색 확인 바로 답해 주세요.',
  sent: '발급목록에 없다는 확인을 기록했어요. 다시 발급하려면 새로 승인해야 해요.',
  stale: '이 건의 확인 요청이 끝났거나 바뀌어서 받지 않았어요. 아무것도 기록하지 않았어요.',
  expired: '확인 바를 누른 뒤 시간이 지나 받지 않았어요. 아무것도 기록하지 않았어요.',
  not_sent: '앱 엔진이 멈춰 확인을 보내지 못했어요. 아무것도 기록하지 않았어요.',
  unknown: '확인이 기록됐는지 알 수 없어요. 앱을 다시 연 뒤 이 건을 다시 확인해 주세요.',
} as const;

/** 게이트 없이 끝난 실행이 연달아 이만큼이면 잠시(PREPARE_PAUSE_MS) 준비를 받지 않는다(ADR-027 결정 8). */
export const GATELESS_STREAK_MAX = 3;
export const PREPARE_PAUSE_MS = 60_000;
/** 홈택스 예행의 고정 초안(부장 2026-11-13): 일호유통, 품목 예행, 공급가 1원, 이메일 없음. */
export const REHEARSAL = { name: '일호유통', bizNo: '6495800524', item: '예행', supply: 1 } as const;

/** 엔진 answer() 거부 중 [중지]·만료가 먼저 게이트를 닫아서 생긴 것(근거 문제 아님). */
const RACED = new Set(['stopped', 'gate_expired', 'no_open_gate', 'not_open']);

/** 셸이 쓰는 엔진 연결 부분(시험은 가짜로 바꿔 끼운다). 게이트 답을 보내는 메서드는 넣지 않는다(shell-app의 승인 바 결과 처리만 쓴다). */
export type RunHost = Pick<EngineHost, 'on' | 'control' | 'rpc'>;
/** 증언 바에 올리기 전 main이 검사한 요청의 모양(attestSelfCheck가 통과한 것만 남긴다). */
const attestShapeOk = (req: AttestRequest | null | undefined): boolean => {
  try {
    return !!req && req.v === 1 && typeof req.runId === 'string' && typeof req.attestReqId === 'string' && Array.isArray(req.fields) && attestSelfCheck(req) === null;
  } catch {
    return false;
  }
};

export interface ShellRunsSource {
  counterparties(): Counterparty[];
  auth(): string;
  /**
   * 이 PC에서 실행 Chrome을 찾을 수 있는가(금고와 같은 후보 경로, @sax/vault findInstalledChrome). [홈택스에서 준비] 전에 본다.
   * 없으면 엔진을 부르지 않고 초안 카드에 안내를 남긴다(엔진까지 가면 chrome.not_installed로 끝나 [다시 준비]가 필요했다). 없으면(시험) 보지 않는다.
   */
  chromeReady?(): boolean;
  /** 실행이 끝난 상태·코드(화면에는 코드를 보이지 않는다). 값·거래처는 넣지 않는다. */
  log?(name: string, data: Record<string, string>): void;
  /** 점검 끝 자동 재시작이 새 초안을 시작하는 길([홈택스에서 준비]와 같은 상한·레지스트리 재조회). 없으면 prepare 그대로(시험). */
  prepare?(id: string): Promise<unknown>;
}

/** 홈택스 시스템 점검 정지(엔진 portal.maintenance, H-01 2026-11-14 실화면 00:00~06:00). 사람 차례로 넘기지 않는다. */
export const MAINTENANCE_CODE = 'portal.maintenance';
/** 끝 시각 뒤 이만큼 더 기다렸다가 다시 시작한다(점검 해제 직후 화면이 늦게 바뀐다). */
const MAINTENANCE_GRACE_MS = 2 * 60_000;
/** 다른 실행이 진행 중이면 이 간격으로 다시 본다. */
const MAINTENANCE_BUSY_RETRY_MS = 60_000;
/** 이보다 먼 끝 시각은 믿지 않는다(모름으로 보고 [다시 시작]). */
const MAINTENANCE_MAX_MS = 12 * 3_600_000;
const KST_MS = 9 * 3_600_000;

/** 엔진이 준 점검 끝 시각(ISO 또는 KST 'HH:MM')을 시각(ms)으로. 모르면·이상하면 null. */
export function maintenanceUntil(v: unknown, now: number): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let at: number;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 24 || m > 59) return null;
    // 오늘(KST) 그 시각, 이미 지났으면 다음 날
    const day = Math.floor((now + KST_MS) / 86_400_000) * 86_400_000 - KST_MS;
    at = day + (h * 60 + m) * 60_000;
    if (at <= now) at += 86_400_000;
  } else at = Date.parse(v);
  if (!Number.isFinite(at) || at - now > MAINTENANCE_MAX_MS || now - at > MAINTENANCE_MAX_MS) return null;
  return at;
}
const kstHm = (at: number) => new Date(at + KST_MS).toISOString().slice(11, 16);

/** 발급 완료 실행의 문서함 줄(d-<runId>). PDF는 엔진이 보관함에 따로 남긴다. */
// 민원증명의 approvalNo는 접수번호다. 엔진이 번호를 읽지 못했어도 발급(success)이면 끝난 것이다(end).
const issuedDoc = (r: RunView): Doc => r.cert
  ? { id: `d-${r.id}`, name: r.cert.name, kind: '증명서', docName: r.cert.name, profile: 'business', issuedOn: dayOffset(0), expiresOn: null, source: '앱이 발급', noFile: true, purpose: r.cert.inputs.purpose }
  : { id: `d-${r.id}`, name: `세금계산서 · ${r.counterparty.name}`, kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(0), expiresOn: null, source: '앱이 발급', noFile: true };

/** 묶음 승인은 처음 승인한 때부터 이만큼만 뒤 건에 쓴다(그 뒤 건은 승인 카드를 다시 띄운다). */
export const BATCH_APPROVAL_MAX_MS = 30 * 60_000;
/**
 * 이 코드로 끝나면 남은 건을 시작하지 않는다(묶음)·다시 시작하지 않는다(깨어남): 차단·정책·점검 신호, 엔진·금고·패키지·원장·토큰 문제,
 * 발급 여부 모름(in_doubt·verify.unknown). 사람이 멈춘 것(stopped)과 발급 여부를 모르는 끝(inDoubt)도 그렇다.
 */
export const RUN_HALT = /^(portal\.blocked|portal\.maintenance|policy\.|vault\.|engine\.|package\.|ir\.|ledger\.|token\.invalid|verify\.unknown|in_doubt|profile_missing|busy$)/;
/** 한 묶음의 최대 건수. 승인 카드가 건마다 한 줄씩 길어져 작은 창에서도 다 보이는 수다. 넘는 초안은 묶지 않는다. */
export const BATCH_MAX = 5;
/** 바쁨(다른 실행 진행 중)이면 이 간격으로 이만큼 다시 본다. 그래도 바쁘면 묶음을 세운다. */
const BATCH_BUSY_RETRY_MS = 15_000;
const BATCH_BUSY_TRIES = 8;
export const BATCH_SKIPPED_NOTE = '이 건은 시작하지 못해 건너뛰었어요. 값을 고친 뒤 [홈택스에서 준비]를 누르면 승인 카드를 다시 띄워요. 아무것도 발급하지 않았어요.';
export const BATCH_AUTO_NOTE = '묶음 승인으로 이어서 발급해요. 2초 안에 [중지]하면 발급하지 않아요';
export const BATCH_REASK_NOTE = '이 건은 승인 카드에서 따로 승인해 주세요(홈택스 값이 처음 승인 때와 다르거나 처음 거래·처음 보내는 주소예요)';
export const BATCH_HALTED_NOTE = '묶음을 멈췄어요. 남은 건은 [홈택스에서 준비]를 누르면 승인 카드에서 한 건씩 승인해요. 아무것도 발급하지 않았어요.';
export const BATCH_CHANGED_NOTE = '승인 카드를 띄운 뒤 묶음 값이 바뀌어 묶음 승인으로 받지 않았어요. 남은 건은 하나씩 승인해 주세요.';
/** 승인 바를 띄울 때 찍은 묶음(바의 2~N건 줄과 그때 초안 값). 클릭 때 초안이 달라졌으면 묶음 승인으로 받지 않는다. */
export interface BatchOffer {
  batchId: string;
  count: number;
  /** 2~N건(묶은 순서): 상호·합계. 바에 그대로 보인다. */
  lines: Array<{ name: string; total: number }>;
  keys: Map<string, string>;
}
interface Batch {
  id: string;
  runIds: string[];
  /** 처음 승인 카드의 클릭. keys: 아직 게이트 전인 건의 runId → 바를 띄울 때 카드 값(gateKey 모양). 한 번 쓰면 지운다. */
  approval: { at: number; keys: Map<string, string> } | null;
  /** 세운 묶음: 남은 건은 사람이 [홈택스에서 준비]로 한 건씩(묶음 카드 없이) 한다. */
  halted: boolean;
}
export const RESUMED_NOTE = '앱이 다시 켜져 멈췄던 건을 같은 내용으로 이어서 해요. 앞 시도는 승인 전이라 아무것도 발급하지 않았어요.';
export const WAKE_RESUMED_NOTE = '맥이 잠들었다 깨어나 멈춘 건을 같은 내용으로 다시 시작했어요. 앞 시도는 승인 전이라 아무것도 발급하지 않았어요.';
/** 맥이 깨어난 뒤 이 안에 승인 전 단계에서 멈춘 실행은 같은 값으로 한 번 다시 시작한다. */
const WAKE_RESUME_MS = 5 * 60_000;
/** 승인 대조 값(공급받는자 번호·공급가액·세액·합계·품목·받는 이메일·작성일자). 초안은 카드 값, 게이트는 홈택스 되읽기 값. */
const draftKey = (r: RunView) => JSON.stringify([r.counterparty.bizNo, String(r.supply), String(r.tax), String(r.total), r.item, r.email.value, r.writeDate]);
const gateKey = (f: Map<string, string>) => JSON.stringify([f.get('counterpartBizNo'), f.get('supplyAmount'), f.get('taxAmount'), f.get('totalAmount'), f.get('itemName'), f.get('counterpartEmail') ?? '', f.get('issueDate')]);

/**
 * 이벤트: 'update'(RunView) · 'gate'(runId, GateRequest) · 'gate-closed'(runId, reqId, reason) · 'doc'(Doc)
 * · 'attest-ready'(runId) · 'attest-withdrawn'(runId, attestReqId, reason).
 */
export class ShellRuns extends EventEmitter implements Drafts {
  private readonly runs = new Map<string, RunView>();
  /** main이 게이트를 닫은 이유(엔진 종료 코드 대신 보일 문구). 렌더러로 보내지 않는다. */
  private readonly endCodes = new Map<string, string>();
  /** run.start 전후로 [중지]가 온 실행. 시작 중에는 엔진에 실행이 없어 run.stop이 아무것도 멈추지 못한다. */
  private readonly starting = new Set<string>();
  private readonly stopEarly = new Set<string>();
  /** 엔진 상태가 InDoubt인 실행(종료가 아님). 카드는 확인 필요로 보이지만 end·state가 더 온다. */
  private readonly liveInDoubt = new Set<string>();
  /** 엔진 상태가 Paused인 실행(종료가 아님, running으로 다시 돌 수 있다). */
  private readonly paused = new Set<string>();
  /** 엔진이 보낸, 아직 철회·사용되지 않은 증언 요청(실행마다 하나). 렌더러로 보내지 않는다. */
  private readonly attests = new Map<string, AttestRequest>();
  private readonly host: RunHost;
  private readonly src: ShellRunsSource;
  private readonly clock: () => number;
  /** 게이트 없이 연달아 끝난 실행의 끝 시각(게이트가 뜨면 비운다). */
  private gateless: number[] = [];
  /** 앱이 되물은 것(입력 보완). 대화(세션)마다 하나. */
  readonly pending: Pending = emptyPending();

  constructor(host: RunHost, src: ShellRunsSource, clock: () => number = Date.now) {
    super();
    this.host = host;
    this.src = src;
    this.clock = clock;
    host.on('run', (e: EngineEvent) => this.onEngine(e));
    host.on('gate', (req: GateRequest) => this.onGate(req));
    host.on('gate-closed', (e: { runId: string; reqId: string; reason: string }) => this.emit('gate-closed', e.runId, e.reqId, e.reason));
    host.on('attest', (req: AttestRequest) => this.onAttest(req));
    host.on('attest-withdrawn', (w: AttestWithdrawn) => this.onAttestWithdrawn(w));
    host.on('exit', (who: string) => {
      if (who === 'engine') this.engineGone();
    });
  }

  /**
   * 증언 요청(엔진 → 게이트 포트 → main). 무장만 한다: 바는 사용자가 그 카드를 열었을 때 shell-app이 띄운다(ADR-021 결정 5).
   * summaryHash를 다시 계산해 같을 때만, 그리고 InDoubt 카드인 실행에만 받는다. 같은 실행의 새 요청은 앞 요청을 바꾼다.
   */
  private onAttest(req: AttestRequest): void {
    if (!attestShapeOk(req)) return;
    const r = this.runs.get(req.runId);
    if (!r || !r.inDoubt) return;
    this.attests.set(r.id, req);
    r.attest = { state: 'ready', note: req.manualCheck === true ? ATTEST_NOTE.manual : ATTEST_NOTE.ready };
    this.emit('update', r);
    this.emit('attest-ready', r.id);
  }

  /** 철회(resolved·gate·aborted). 그 요청일 때만 지운다. 바는 shell-app이 내린다. */
  private onAttestWithdrawn(w: AttestWithdrawn): void {
    const cur = this.attests.get(w?.runId);
    if (!cur || cur.attestReqId !== w.attestReqId) return;
    this.attests.delete(w.runId);
    const r = this.runs.get(w.runId);
    if (r?.attest?.state === 'ready') {
      r.attest = null;
      this.emit('update', r);
    }
    this.emit('attest-withdrawn', w.runId, w.attestReqId, w.reason);
  }

  /** 그 실행의 무장된 증언 요청(바에 올릴 것). 없으면 null. */
  attestFor(runId: string): AttestRequest | null {
    return this.attests.get(runId) ?? null;
  }

  /** 증언 바가 근거를 발급했다. 같은 요청은 한 번만 쓴다(엔진도 두 번째를 거부한다). 보내기 전에 부른다. */
  attestUsed(runId: string, attestReqId: string): void {
    if (this.attests.get(runId)?.attestReqId === attestReqId) this.attests.delete(runId);
  }

  /**
   * 엔진의 증언 판정. 받아들이면 엔진이 원장에 not_committed(attested)를 먼저 쓰고 그 뒤 상태(새 게이트·정지)를 이벤트로 보낸다.
   * 셸은 그 상태를 미리 가정하지 않는다. 카드에는 기록했다는 문구만 둔다.
   */
  onAttestAnswer(runId: string, a: AttestAnswerResult): void {
    const r = this.runs.get(runId);
    if (!r) return;
    const note = a.ok ? ATTEST_NOTE.sent : a.verdict === 'not_sent' ? ATTEST_NOTE.not_sent : a.verdict === 'unknown' ? ATTEST_NOTE.unknown : a.code === 'attest.expired' ? ATTEST_NOTE.expired : ATTEST_NOTE.stale;
    r.attest = { state: a.ok ? 'sent' : 'refused', note };
    this.emit('update', r);
  }

  /**
   * 엔진이 끝났다. 진행 중인 실행을 끝낸다. 승인을 보냈거나 발급 중이었으면 발급됐는지 모른다(in_doubt, 중복 위험 문구).
   * 원장 행은 다음 기동 때 엔진이 in_doubt로 올린다(D03 §4).
   */
  private engineGone(): void {
    // 증언 요청을 받을 엔진이 없다. 카드의 "확인 바가 떠요" 문구도 거둔다(바는 shell-app이 engine_exit로 내린다).
    for (const id of this.attests.keys()) {
      const r = this.runs.get(id);
      if (r?.attest?.state === 'ready') {
        r.attest = null;
        this.emit('update', r);
      }
    }
    this.attests.clear();
    // InDoubt·멈춤 상태(종료 아님)인 실행은 카드를 그대로 두고 금고 실행만 끝낸다. 다음 기동에 엔진이 state in_doubt로 복원한다.
    for (const id of [...this.liveInDoubt, ...this.paused]) void this.host.control('run.end', { runId: id }).catch(() => {});
    this.liveInDoubt.clear();
    this.paused.clear();
    for (const r of this.runs.values()) {
      if (!['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)) continue;
      // 게이트 뒤 단계에서 넘겨받은 핸드오프도 발급됐는지 모른다(사용자가 직접 발급했을 수 있다, R-C2).
      const unsure = r.status === 'issuing' || r.approvedPending === true || r.handoff?.afterGate === true;
      this.end(r, unsure ? { status: 'in_doubt', code: 'engine.exit' } : { status: 'failed', code: 'engine.exit_before_approval' });
    }
  }

  get counterparties(): Counterparty[] {
    return this.src.counterparties();
  }

  get(id: string): RunView | undefined {
    return this.runs.get(id);
  }

  /** 지금 들고 있는 실행 전부(만든 순서). 이번 달 판이 읽는다. */
  list(): RunView[] {
    return [...this.runs.values()];
  }

  /** 예행 초안(REHEARSAL). 이메일 칸은 비운다(자동 발송 없음). */
  rehearsalDraft(cp: Counterparty): RunView {
    const d = this.createDraft(cp, REHEARSAL.supply, 'separate', REHEARSAL.item);
    d.email = { value: '', first: false };
    d.rehearsal = true;
    return d;
  }

  /** item: 문장에서 뽑았거나 되묻기에서 받은 품목. 없으면 거래처의 저장 품목(추정). */
  createDraft(cp: Counterparty, amount: number, vat: VatMode | null, item?: string | null): RunView {
    const s = split(amount, vat ?? 'separate');
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'H-01',
      cert: null,
      status: 'draft',
      createdAt: hm(),
      // 처음 거래·처음 보내는 주소는 게이트 때 엔진이 원장으로 판정한다(초안에서는 모름).
      counterparty: { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false },
      email: { value: cp.email, first: false },
      amount,
      vat: vat ?? 'separate',
      vatGuessed: vat === null,
      ...s,
      item: cleanItem(item ?? '') ?? cleanItem(cp.item ?? '') ?? '',
      itemGuessed: !cleanItem(item ?? ''),
      writeDate: dayOffset(0),
      auth: this.src.auth(),
      steps: stepsOf('H-01'),
      turn: null,
      confirmed: false,
      result: null,
      warnings: [],
    };
    this.markDup(run);
    this.runs.set(run.id, run);
    return run;
  }

  /**
   * 민원증명 초안(cert-docs 표의 서류, run.startCert inputs 그대로). 고칠 칸은 없다: 신청 값은 승인 카드에서 보고, 다르면 [중지] 뒤 다시 말한다.
   * 거래처·금액·품목·이메일 칸은 빈 값이다. 시작은 prepare다(같은 Chrome 점검·[중지] 처리·한 번에 하나).
   */
  createCertDraft(code: CertCode, inputs: Record<string, string>, o: { rehearsal?: boolean } = {}): RunView {
    const def = certDocByCode(code);
    if (!def) throw new Error('cert.unknown_doc');
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'cert',
      cert: { code: def.code, playbookId: def.playbookId, name: def.name, docType: def.docType, inputs: { ...inputs } },
      status: 'draft',
      createdAt: hm(),
      counterparty: { id: '', name: '', bizNo: '', first: false },
      email: { value: '', first: false },
      amount: 0,
      vat: 'separate',
      vatGuessed: false,
      supply: 0,
      tax: 0,
      total: 0,
      item: '',
      itemGuessed: false,
      writeDate: dayOffset(0),
      auth: this.src.auth(),
      steps: stepsOf('cert'),
      turn: null,
      confirmed: false,
      result: null,
      warnings: [],
      ...(o.rehearsal ? { rehearsal: true } : {}),
    };
    this.runs.set(run.id, run);
    return run;
  }

  /** 민원증명을 바로 시작한다(초안 + prepare). 예행은 {rehearsal: true}: 엔진이 승인 카드 자리에서 스스로 멈춘다. 실행 상한은 부르는 쪽(shell-app prepareNow)이 본다. */
  startCert(code: CertCode, inputs: Record<string, string>, o: { rehearsal?: boolean } = {}): Promise<RunView> {
    return this.prepare(this.createCertDraft(code, inputs, o).id);
  }

  /** 초안의 오늘 중복 표시(F-10): 오늘 발급을 마친(또는 발급됐는지 모르는) 같은 거래처·같은 합계 실행이 있는가. 거래처·금액을 고치면 다시 본다. */
  private markDup(r: RunView): void {
    const today = dayOffset(0);
    r.dupToday = [...this.runs.values()].some((x) => x.id !== r.id && (x.status === 'done' || x.inDoubt === true) && x.writeDate === today && x.counterparty.id === r.counterparty.id && x.total === r.total);
  }

  updateDraft(id: string, patch: { vat?: VatMode; amount?: number; amountText?: string; item?: string; email?: string; counterpartyId?: string }): RunView {
    if (patch.amountText !== undefined) {
      const t = patch.amountText.trim();
      const v = parseAmount(/^[\d,]+$/.test(t) ? `${t}원` : t);
      if (v === null) throw new Error('bad_amount');
      patch = { ...patch, amount: v };
    }
    const r = this.mustDraft(id);
    if (r.cert) throw new Error('not_draft');
    // 카드에서 거래처 바꾸기(F-14): 장부의 거래처로만. 받는 이메일은 새 거래처 것, 품목은 저장 품목에서 온 추정이었으면 새 거래처의 저장 품목.
    // 대화·카드에서 받은 품목은 그대로 둔다. 같은 patch의 item·email이 그 뒤에 덮는다.
    if (patch.counterpartyId !== undefined && patch.counterpartyId !== r.counterparty.id) {
      const cp = this.src.counterparties().find((c) => c.id === patch.counterpartyId);
      if (!cp) throw new Error('no_counterparty');
      r.counterparty = { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false };
      r.email = { value: cp.email, first: false };
      if (r.itemGuessed || !cleanItem(r.item)) {
        r.item = cleanItem(cp.item ?? '') ?? '';
        r.itemGuessed = true;
      }
    }
    if (patch.vat) {
      r.vat = patch.vat;
      r.vatGuessed = false;
    }
    if (patch.amount !== undefined) {
      if (!Number.isInteger(patch.amount) || patch.amount <= 0 || patch.amount > 1e12) throw new Error('bad_amount');
      r.amount = patch.amount;
    }
    // 카드에서 고친 품목·받는 이메일(08 §2 "값은 카드 필드로 보여 주고 그 자리에서 고친다"). 품목은 비울 수 없다(엔진 item_missing).
    if (patch.item !== undefined) {
      const v = cleanItem(patch.item);
      if (!v) throw new Error('item_required');
      r.item = v;
      r.itemGuessed = false;
    }
    if (patch.email !== undefined) {
      const v = patch.email.trim().slice(0, 320);
      if (!emailOk(v)) throw new Error('bad_email');
      r.email = { ...r.email, value: v };
    }
    Object.assign(r, split(r.amount, r.vat));
    this.markDup(r);
    this.emit('update', r);
    return r;
  }

  /** 대화 에이전트의 draft_discard: 발급 전 초안만 버린다. 카드는 "취소함"으로 한 번 그리고 목록에서 뺀다(판·프레임에 남지 않게). */
  discardDraft(id: string): RunView {
    const r = this.mustDraft(id);
    this.runs.delete(id);
    const shown = { ...r, discarded: true };
    this.emit('update', shown);
    return shown;
  }

  private mustDraft(id: string): RunView {
    const r = this.runs.get(id);
    if (!r || r.status !== 'draft') throw new Error('not_draft');
    return r;
  }

  private busy(): boolean {
    return [...this.runs.values()].some((x) => ['preparing', 'turn', 'waiting', 'issuing'].includes(x.status));
  }

  /** 진행 중인 실행이 하나라도 있는가(내 사업장 저장을 막는다). */
  anyActive(): boolean {
    return this.busy();
  }

  /** 진행 중인 실행인가(비밀 창은 이 실행의 요청만 연다). */
  isActive(runId: string): boolean {
    const r = this.runs.get(runId);
    return !!r && ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status);
  }

  /** 게이트 없이 끝난 실행이 연달아 GATELESS_STREAK_MAX번이고 마지막 끝에서 PREPARE_PAUSE_MS가 안 지났는가. */
  prepareThrottled(): boolean {
    return this.prepareWaitMs() > 0;
  }

  /** 승인 카드 없이 끝난 실행이 연달아 이어져 쉬는 중이면 남은 시간(ms), 아니면 0(F-07: 화면이 기다릴 시간을 말한다). */
  prepareWaitMs(): number {
    const last = this.gateless.at(-1);
    if (this.gateless.length < GATELESS_STREAK_MAX || last === undefined) return 0;
    const left = PREPARE_PAUSE_MS - (this.clock() - last);
    if (left > 0) return left;
    this.gateless = [];
    return 0;
  }

  /** 카드에 문장 하나를 더한다(금고 이벤트 등). runId가 없거나 끝난 실행이면 진행 중인 실행에. 같은 문장은 한 번만. */
  /**
   * 실행 Chrome이 사람 손으로 닫혔다(금고 browser.closed: 탭 전부 또는 프로세스, 대표 실화면 2026-11-13).
   * 제출 전(준비·사람 차례·승인 대기)이면 엔진에 멈춤을 보내고 끝 문구를 "브라우저가 닫혔어요 [다시 시작]"으로 정한다.
   * 승인 뒤(발급 중)면 멈추지 않는다: 발급됐는지 엔진 확인이 먼저다(안내만 붙인다). 엔진 끝이 먼저 왔으면(같은 순간) 그 카드를 고쳐 쓴다.
   */
  browserClosed(): void {
    const now = this.clock();
    this.goneAt = now;
    for (const r of this.runs.values()) {
      const pastGate = r.status === 'issuing' || r.approvedPending === true || r.handoff?.afterGate === true;
      if (['preparing', 'turn', 'waiting'].includes(r.status) && !pastGate) {
        r.browserClosed = true;
        this.endCodes.set(r.id, 'browser.closed');
        void this.stop(r.id).catch(() => {});
      } else if (r.status === 'issuing' || (pastGate && this.isActive(r.id))) {
        r.notices = [...(r.notices ?? []), '브라우저가 닫혔어요. 발급됐는지 확인하고 있어요.'];
        this.emit('update', r);
      } else if ((r.status === 'attention' || r.status === 'stopped') && !r.inDoubt && r.redo && r.endedAt !== undefined && now - r.endedAt < 10_000) {
        this.markClosed(r);
        this.emit('update', r);
      }
    }
  }
  private goneAt = Number.NEGATIVE_INFINITY;
  /** 브라우저가 닫혀 멈춘 제출 전 실행의 끝 모양(부른 쪽이 update를 낸다). */
  private markClosed(r: RunView): void {
    r.browserClosed = true;
    r.status = 'stopped';
    r.stoppedNote = NOTE['browser.closed'];
    r.redo = true;
  }

  notice(runId: string | undefined, text: string, retry?: 'extension'): void {
    const own = runId ? this.runs.get(runId) : undefined;
    const active = [...this.runs.values()].find((x) => this.isActive(x.id));
    const r = own && this.isActive(own.id) ? own : (active ?? own);
    if (!r) return;
    r.notices = [...(r.notices ?? []).filter((t) => t !== text), text];
    if (retry) r.retry = retry;
    this.emit('update', r);
  }

  dropNotice(runId: string, text: string): void {
    const r = this.runs.get(runId);
    if (!r?.notices?.includes(text)) return;
    r.notices = r.notices.filter((t) => t !== text);
    this.emit('update', r);
  }

  private readonly batches = new Map<string, Batch>();

  /** 한 요청에서 만든 초안 둘 이상을 한 카드로 묶는다. 실행은 한 건씩 차례로 돌고, 승인은 처음 승인 카드 한 번이다. */
  makeBatch(ids: string[]): string | null {
    const rs = ids
      .map((id) => this.runs.get(id))
      .filter((r): r is RunView => !!r && r.status === 'draft' && !r.batch && !r.rehearsal)
      .slice(0, BATCH_MAX);
    if (rs.length < 2) return null;
    const id = `batch-${randomUUID().slice(0, 8)}`;
    this.batches.set(id, { id, runIds: rs.map((r) => r.id), approval: null, halted: false });
    rs.forEach((r, index) => {
      r.batch = { id, index, count: rs.length };
      this.emit('update', r);
    });
    return id;
  }

  private batchFor(runId: string): Batch | undefined {
    const b = this.runs.get(runId)?.batch;
    return b ? this.batches.get(b.id) : undefined;
  }

  /** 묶음의 건들(묶은 순서). 버린 초안은 빠진다. */
  batchRuns(batchId: string): RunView[] {
    return (this.batches.get(batchId)?.runIds ?? []).map((id) => this.runs.get(id)).filter((r): r is RunView => !!r);
  }

  /** 묶음에서 차례를 기다리는 초안(건너뛰지 않은 것). */
  private batchQueued(b: Batch, except?: string): RunView[] {
    return this.batchRuns(b.id).filter((x) => x.id !== except && x.status === 'draft' && !x.batch?.skipped);
  }

  /** 묶음 차례가 남았는가(앞 건이 진행 중이거나, 세우지 않은 묶음에 차례를 기다리는 초안이 있다). 끝 알림이 쓴다. */
  batchOpen(batchId: string): boolean {
    const b = this.batches.get(batchId);
    return !!b && (this.batchRuns(batchId).some((x) => this.isActive(x.id)) || (!b.halted && this.batchQueued(b).length > 0));
  }

  /** 묶음 승인으로 차례를 기다리는 초안인가(이어 하기가 남긴다). 멈춘 묶음·건너뛴 초안·승인 전 묶음은 아니다. */
  batchWaiting(r: RunView): boolean {
    const b = r.batch && this.batches.get(r.batch.id);
    return !!b && r.status === 'draft' && !r.batch!.skipped && !r.batch!.halted && (b.approval?.keys.has(r.id) === true || this.batchRuns(b.id).some((x) => this.isActive(x.id)));
  }

  /** 이 게이트의 승인 카드에 올릴 묶음(이 건 + 아직 시작하지 않은 건). 묶음 승인 전이고 둘 이상일 때만, 아니면 null. 바를 띄울 때 부른다. */
  batchOffer(runId: string): BatchOffer | null {
    const b = this.batchFor(runId);
    if (!b || b.approval || b.halted) return null;
    const rest = this.batchQueued(b, runId);
    if (!rest.length) return null;
    return { batchId: b.id, count: rest.length + 1, lines: rest.map((x) => ({ name: x.counterparty.name, total: x.total })), keys: new Map(rest.map((x) => [x.id, draftKey(x)])) };
  }

  /**
   * 승인 바가 묶음 글자로 그린 카드에서 클릭을 받았다(근거를 보내기 직전). 바를 띄울 때 찍은 초안과 지금 초안이 같을 때만 묶음 승인으로 기록한다.
   * 달라졌으면(그 사이 초안을 고쳤다) 묶음 승인 없이 이 건만 간다. 남은 건은 저마다 승인 카드를 띄운다.
   */
  batchApproved(runId: string, offer: BatchOffer): boolean {
    const b = this.batchFor(runId);
    if (!b || b.approval || b.id !== offer.batchId) return false;
    const now = new Map(this.batchQueued(b, runId).map((x) => [x.id, draftKey(x)]));
    const same = now.size === offer.keys.size && [...offer.keys].every(([id, k]) => now.get(id) === k);
    this.src.log?.('main.batch_approved', { count: String(offer.count), same: same ? 'yes' : 'no' });
    if (!same) return false;
    b.approval = { at: this.clock(), keys: new Map(offer.keys) };
    b.halted = false;
    for (const x of this.batchRuns(b.id)) {
      x.batch = { ...x.batch!, approved: true, halted: false };
      this.emit('update', x);
    }
    return true;
  }

  /**
   * 묶음 승인으로 이 게이트를 바 없이 이어 가도 되는가. 바와 같은 검사(gateSelfCheck·summarize)를 지나고, 홈택스 되읽기 값이 승인 때 카드 값과 같고,
   * 중복·처음 거래·처음 보내는 주소 표시가 없고, 승인한 지 BATCH_APPROVAL_MAX_MS 안일 때만. 한 번 물으면 지운다(아니면 이 건은 승인 카드를 띄운다).
   */
  batchAutoApprove(runId: string, req: GateRequest): boolean {
    const b = this.batchFor(runId);
    const key = b?.approval?.keys.get(runId);
    if (!b?.approval || key === undefined) return false;
    b.approval.keys.delete(runId);
    const f = new Map<string, string>(req.fields.map((x) => [x.fieldKey, x.value]));
    const shape = (() => {
      try {
        return req.v === 2 && Array.isArray(req.fields) && gateSelfCheck(req) === null && Array.isArray(summarize(req, kstToday(this.clock())));
      } catch {
        return false;
      }
    })();
    const ok =
      shape &&
      this.clock() - b.approval.at <= BATCH_APPROVAL_MAX_MS &&
      ![...f.keys()].some((k) => k.startsWith('$dup.')) &&
      f.get('$first.bizNo') !== 'true' &&
      f.get('$first.email') !== 'true' &&
      gateKey(f) === key;
    if (!ok) {
      const r = this.runs.get(runId)!;
      this.step(r, 'gate', 'now', BATCH_REASK_NOTE);
      this.emit('update', r);
    }
    this.src.log?.('main.batch_gate', { auto: ok ? 'yes' : 'no' });
    return ok;
  }

  /** 묶음을 세운다: 묶음 승인을 버리고(남은 초안은 저마다 승인 카드) 카드에 멈춤 문구를 둔다. */
  private batchHalt(b: Batch, why: string): void {
    b.approval = null;
    b.halted = true;
    for (const x of this.batchRuns(b.id)) {
      x.batch = { ...x.batch!, approved: false, halted: true };
      this.emit('update', x);
    }
    this.src.log?.('main.batch_halt', { code: why.slice(0, 60) });
  }

  /**
   * 묶음 건 하나가 끝났다(end가 카드 update를 내기 전에 부른다: 묶음이 서면 그 update가 끝 알림이 된다).
   * 사람이 멈췄거나 발급 여부를 모르거나 RUN_HALT 신호면 묶음을 세우고, 아니면 다음 초안을 시작한다. 세운 묶음은 사람이 한 건씩 한다.
   */
  private batchAfter(r: RunView, code: string | undefined): void {
    const b = this.batchFor(r.id);
    if (!b || b.halted) return;
    if (r.status === 'stopped' || r.inDoubt || RUN_HALT.test(code ?? '')) return this.batchHalt(b, code ?? r.status);
    if (!this.batchQueued(b).length) return;
    setImmediate(() => void this.batchNext(b.id));
  }

  /**
   * 묶음의 다음 초안을 [홈택스에서 준비]와 같은 길로 시작한다. 상한(throttled)이면 그 초만큼, 바쁨이면 BATCH_BUSY_RETRY_MS 뒤 다시 본다.
   * 다른 길로 이미 시작된 건(not_draft)은 그대로 둔다. 시작할 수 없는 건은 건너뛰고 묶음 승인에서 뺀다(다시 준비하면 승인 카드).
   */
  private async batchNext(batchId: string, tries = 0): Promise<void> {
    const b = this.batches.get(batchId);
    const next = b && !b.halted && this.batchQueued(b)[0];
    if (!b || !next) return;
    const later = (ms: number) => {
      const t = setTimeout(() => void this.batchNext(batchId, tries + 1), ms);
      t.unref?.();
    };
    if (this.busy()) return tries < BATCH_BUSY_TRIES ? later(BATCH_BUSY_RETRY_MS) : this.batchHalt(b, 'busy');
    try {
      await (this.src.prepare ? this.src.prepare(next.id) : this.prepare(next.id));
    } catch (e) {
      const why = (e as Error).message ?? '';
      const wait = /^throttled\.[a-z]+:(\d+)$/.exec(why);
      if (wait) return tries < BATCH_BUSY_TRIES ? later(Number(wait[1]) * 1000 + 500) : this.batchHalt(b, 'throttled');
      if (why === 'busy') return tries < BATCH_BUSY_TRIES ? later(BATCH_BUSY_RETRY_MS) : this.batchHalt(b, 'busy');
      if (why === 'not_draft' || this.runs.get(next.id)?.status !== 'draft') return;
      b.approval?.keys.delete(next.id);
      next.batch = { ...next.batch!, skipped: true };
      next.notices = [...(next.notices ?? []).filter((x) => x !== BATCH_SKIPPED_NOTE), BATCH_SKIPPED_NOTE];
      this.emit('update', next);
      this.src.log?.('main.batch_skip', { why: why.slice(0, 60) });
      return this.batchNext(batchId, tries);
    }
  }

  /**
   * 앱이 다시 켜졌다(run-resume.ts가 남긴 커밋 전 일). 같은 값의 초안을 만들고 묶음은 다시 묶는다. 승인은 새로 받는다(앞 승인은 쓰지 않는다).
   * 시작할 첫 초안을 돌려준다(시작은 shell-app이 [홈택스에서 준비]와 같은 길로). 거래처가 장부에서 지워졌으면 그 건은 뺀다.
   */
  restore(items: ResumeItem[]): RunView | null {
    const made: Array<{ d: RunView; it: ResumeItem }> = [];
    for (const it of items) {
      const cp = this.src.counterparties().find((c) => c.id === it.counterpartyId);
      if (!cp) continue;
      const d = this.createDraft(cp, it.amount, it.vat, it.item);
      if (it.email !== undefined && emailOk(it.email)) d.email = { value: it.email, first: false };
      d.resumedFrom = it.from;
      d.notices = [RESUMED_NOTE];
      made.push({ d, it });
    }
    const groups = new Map<string, RunView[]>();
    for (const { d, it } of [...made].sort((a, b) => (a.it.index ?? 0) - (b.it.index ?? 0))) if (it.batch) groups.set(it.batch, [...(groups.get(it.batch) ?? []), d]);
    for (const g of groups.values()) this.makeBatch(g.map((d) => d.id));
    for (const { d } of made) this.emit('update', d);
    this.src.log?.('main.run_restored', { count: String(made.length), dropped: String(items.length - made.length) });
    return made.find(({ d }) => !d.batch || d.batch.index === 0)?.d ?? null;
  }

  private wokeAt = Number.NEGATIVE_INFINITY;
  /** 맥이 깨어났다(powerMonitor resume). */
  woke(): void {
    this.wokeAt = this.clock();
  }

  /** 깨어난 직후 승인 전 단계에서 멈춘 실행(묶음 밖, 다시 준비할 수 있는 것)을 같은 값으로 한 번 다시 시작한다. */
  private wakeAfter(r: RunView, code: string | undefined): void {
    if (this.clock() - this.wokeAt > WAKE_RESUME_MS || r.batch || r.rehearsal || r.maintenance || r.status !== 'attention' || !r.redo || r.inDoubt || RUN_HALT.test(code ?? '') || r.notices?.includes(WAKE_RESUMED_NOTE)) return;
    setImmediate(() => {
      let d: RunView;
      try {
        d = this.redraft(r.id);
      } catch {
        return;
      }
      d.resumedFrom = r.id;
      d.notices = [WAKE_RESUMED_NOTE];
      this.emit('update', d);
      this.src.log?.('main.wake_restart', {});
      void (this.src.prepare ? this.src.prepare(d.id) : this.prepare(d.id)).catch((e: Error) => this.src.log?.('main.wake_restart_failed', { why: e.message.slice(0, 60) }));
    });
  }

  /** [홈택스에서 준비]: 엔진 run.start. 실행은 한 번에 하나다(08 §5). 엔진이 시작 전에 거부하면 확인 필요로 둔다. */
  async prepare(id: string): Promise<RunView> {
    const r = this.mustDraft(id);
    // 품목이 비면 엔진이 시작하지 않는다(item_missing). 카드를 끝내지 않고 그대로 두고 품목을 넣게 한다.
    if (!r.cert && !cleanItem(r.item)) throw new Error('item_required');
    // 받는 이메일은 홈택스에 아이디·도메인 두 칸으로 들어간다(H-01 2.2.0). 모양이 틀린 장부 값은 시작하지 않고 고치게 한다.
    if (!r.cert && !emailOk(r.email.value)) throw new Error('bad_email');
    if (this.busy()) throw new Error('busy');
    // Chrome 사전 점검(#275 후보: /Applications·~/Applications, Windows Program Files·LocalAppData). 없으면 시작하지 않고 카드에 남긴다.
    const noChrome = !!this.src.chromeReady && !this.src.chromeReady();
    if (noChrome || r.noChrome) {
      r.noChrome = noChrome;
      this.emit('update', r);
      if (noChrome) throw new Error('chrome.not_installed');
    }
    // 발급 인증은 시작하는 순간의 기본값이다. 엔진도 run.start 때 프로필 signMethod를 읽어 그 실행 동안 쓴다(runs.ts start).
    // 초안을 만든 뒤 설정에서 기본을 바꿨으면 카드 안내도 그 값으로 맞춘다. 시작한 뒤에 바꾼 기본은 이 실행에 닿지 않는다(설정 화면 문구).
    r.auth = this.src.auth();
    r.status = 'preparing';
    this.step(r, 'login', 'now', LOGIN_NOW);
    this.emit('update', r);
    this.starting.add(r.id);
    try {
      await this.host.control('run.begin', { runId: r.id, trigger: 'local' });
      if (this.stopEarly.has(r.id)) {
        this.end(r, { status: 'stopped', code: 'run.stopped' });
        return r;
      }
      const rehearsal = r.rehearsal ? { rehearsal: true } : {};
      if (r.cert) await this.host.rpc('run.startCert', { runId: r.id, playbookId: r.cert.playbookId, inputs: r.cert.inputs, ...rehearsal });
      else await this.host.rpc('run.start', { runId: r.id, counterpartyId: r.counterparty.id, supply: r.supply, tax: r.tax, itemName: r.item, email: r.email.value || null, ...rehearsal });
      // 시작하는 동안 온 [중지]를 이제 엔진에 전한다(엔진은 다음 정지 확인에서 멈춘다. 게이트 전이다).
      if (this.stopEarly.has(r.id)) await this.host.rpc('run.stop', { runId: r.id }).catch(() => {});
    } catch (e) {
      this.end(r, { status: 'failed', code: (e as Error).message });
    } finally {
      this.starting.delete(r.id);
      this.stopEarly.delete(r.id);
    }
    return r;
  }

  /** 기본 발급 인증이 바뀌었다(설정·온보딩). 아직 시작하지 않은 초안만 새 값을 보인다. 진행 중인 실행은 시작 때 값 그대로다. */
  syncAuth(): void {
    const auth = this.src.auth();
    for (const r of this.runs.values()) {
      if (r.status !== 'draft' || r.auth === auth) continue;
      r.auth = auth;
      this.emit('update', r);
    }
  }

  /**
   * [다시 준비]: 발급 전에 멈춘 실행과 같은 값(거래처·금액·부가세·품목·받는 이메일)으로 새 초안을 만든다. 실행은 새 초안의 [홈택스에서 준비]로만 시작한다.
   * 고르지 않았던 부가세·저장 품목에서 온 품목은 추정 그대로 둔다. 거래처가 장부에서 지워졌으면 no_counterparty.
   */
  redraft(id: string): RunView {
    const r = this.runs.get(id);
    // 민원증명은 같은 서류·신청 값으로 다시 뗀다([한 번 더 떼기]·[다시 준비]·[다시 시작]). 발급됐는지 모르는 실행만 뺀다. 같은 날 두 번째 발급은 승인 카드의 중복 경고가 알린다.
    if (r?.cert && (r.status === 'done' || ((r.status === 'attention' || r.status === 'stopped') && !r.inDoubt))) return this.markRestarted(r, this.createCertDraft(r.cert.code, r.cert.inputs));
    // 확인 필요로 끝난 발급 전 실행, 또는 브라우저가 닫혀 멈춘 발급 전 실행([다시 시작])
    if (!r || !r.redo || !(r.status === 'attention' || (r.status === 'stopped' && r.browserClosed))) throw new Error('not_redoable');
    const cp = this.src.counterparties().find((c) => c.id === r.counterparty.id);
    if (!cp) throw new Error('no_counterparty');
    const d = this.createDraft(cp, r.amount, r.vatGuessed ? null : r.vat, r.itemGuessed ? null : r.item);
    if (emailOk(r.email.value)) d.email = { value: r.email.value, first: false };
    return this.markRestarted(r, d);
  }

  /** 점검으로 멈춘 실행은 한 번만 다시 시작한다(사람이 먼저 눌렀으면 자동 재시작을 하지 않는다). */
  private markRestarted(r: RunView, d: RunView): RunView {
    if (r.maintenance) {
      r.maintenance.restartedAs = d.id;
      this.clearMaintenanceTimer(r.id);
      this.emit('update', r);
    }
    return d;
  }

  private readonly maintTimers = new Map<string, NodeJS.Timeout>();
  private clearMaintenanceTimer(id: string): void {
    clearTimeout(this.maintTimers.get(id));
    this.maintTimers.delete(id);
  }
  private maintenanceAfter(id: string, ms: number): void {
    this.clearMaintenanceTimer(id);
    const t = setTimeout(() => void this.maintenanceRestart(id), Math.max(0, ms));
    t.unref?.();
    this.maintTimers.set(id, t);
  }

  /** 홈택스 점검으로 멈춤: 팝업·사람 차례 없이 카드 글로. 끝 시각을 알면 그 뒤 같은 값으로 자동 재시작, 모르면 [다시 시작]. */
  private maintenanceEnd(r: RunView, untilRaw: string | undefined): void {
    const at = maintenanceUntil(untilRaw, this.clock());
    r.maintenance = { until: at === null ? null : kstHm(at) };
    r.stoppedNote = at === null ? MAINTENANCE_UNKNOWN_NOTE : maintenanceNote(kstHm(at));
    if (at !== null) this.maintenanceAfter(r.id, at - this.clock() + MAINTENANCE_GRACE_MS);
    this.src.log?.('main.maintenance_end', { until: at === null ? 'unknown' : 'known' });
  }

  /** 점검 끝 시각이 지났다: 같은 값의 새 초안을 만들어 바로 시작한다. 다른 실행이 진행 중이면 1분 뒤 다시 본다. */
  private async maintenanceRestart(id: string): Promise<void> {
    this.maintTimers.delete(id);
    const r = this.runs.get(id);
    if (!r?.maintenance || r.maintenance.restartedAs || r.status !== 'attention') return;
    if (this.busy()) return this.maintenanceAfter(id, MAINTENANCE_BUSY_RETRY_MS);
    let d: RunView | null = null;
    try {
      d = this.redraft(id);
      d.notices = [MAINTENANCE_RESTARTED_NOTE];
      this.emit('update', d);
      this.src.log?.('main.maintenance_restart', {});
      await (this.src.prepare ? this.src.prepare(d.id) : this.prepare(d.id));
    } catch (err) {
      // 시작하지 못했다(상한·Chrome 없음·거래처 없음 등): 멈춘 카드에 [다시 시작]을 되살린다
      const why = (err as Error).message ?? '';
      if (d && d.status === 'draft') {
        d.notices = [MAINTENANCE_RESTART_FAILED_NOTE];
        this.emit('update', d);
      } else if (!d) {
        r.maintenance = { until: null };
        r.stoppedNote = MAINTENANCE_UNKNOWN_NOTE;
        this.emit('update', r);
      }
      this.src.log?.('main.maintenance_restart_failed', { why: why.slice(0, 60) });
    }
  }

  /** [중지]·[취소]: 초안이면 바로, 실행 중이면 엔진에 알린다(커밋 구간이면 엔진이 거부). */
  async stop(id: string): Promise<RunView> {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status === 'draft') {
      r.status = 'stopped';
      r.stoppedNote = '취소했어요.';
      this.emit('update', r);
      return r;
    }
    if (!['preparing', 'turn', 'waiting'].includes(r.status)) {
      if (r.status === 'issuing') throw new Error('already_issuing');
      return r;
    }
    if (this.starting.has(id)) {
      this.stopEarly.add(id);
      return r;
    }
    const res = (await this.host.rpc('run.stop', { runId: id })) as { stopped?: unknown } | null;
    // 서명 차례의 [중지]는 바로 끝나지 않는다({stopped:false}): 엔진이 서명됐는지 발급목록으로 확인(verify)한 뒤 end가 온다. 그동안 카드는 확인 중이다.
    if (r.status === 'turn' && r.handoff?.kind === 'sign' && res?.stopped === false) {
      r.notices = [...(r.notices ?? []), STOP_AFTER_SIGN_NOTE];
      this.leaveHandoff(r, 'issuing');
      this.step(r, 'sign', 'todo');
      this.step(r, 'verify', 'now');
      this.emit('update', r);
    }
    return r;
  }

  /**
   * 핸드오프 [다 했어요]: 엔진에 재개를 알린다. 엔진은 원장이 in_doubt이면 verify부터 한다(D03 §2). 발급하지 않는다.
   * 게이트 앞이었으면 준비 중으로, 게이트 뒤였으면 확인(발급 중)으로 돌아간다. 엔진이 받은 뒤에만 상태를 바꾼다.
   */
  async resume(id: string): Promise<RunView> {
    const r = this.handedOff(id);
    refused(await this.host.rpc('run.resume', { runId: id }));
    this.leaveHandoff(r, r.handoff!.afterGate ? 'issuing' : 'preparing');
    return r;
  }

  /**
   * 핸드오프 [직접 발급함]: 사용자가 홈택스에서 직접 발급했다고 알린다. 엔진이 원장에 observed_manual을 쓰고 그 X의 verify만 한다(R-C2).
   * 앱은 다시 발급하지 않는다. 카드는 '확인 중'(발급목록 조회)으로 간다.
   */
  async manualDone(id: string): Promise<RunView> {
    const r = this.handedOff(id);
    // 서명 차례에는 [직접 발급함]이 없다(엔진 sign.turn_resume_only). 화면도 버튼을 두지 않는다.
    if (r.handoff!.kind === 'sign') throw new Error('sign.turn_resume_only');
    refused(await this.host.rpc('run.manualDone', { runId: id }));
    r.confirmed = true;
    for (const p of ['login', 'form', 'input', 'readback', 'gate', 'sign'] as const) if (r.steps[PHASES.indexOf(p)]!.state !== 'done') this.step(r, p, 'done', p === 'sign' ? '직접 발급하셨다고 알려 주셨어요' : undefined);
    this.step(r, 'verify', 'now');
    this.leaveHandoff(r, 'issuing');
    return r;
  }

  private handedOff(id: string): RunView {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status !== 'turn' || !r.handoff) throw new Error('not_handed_off');
    return r;
  }

  private leaveHandoff(r: RunView, status: 'preparing' | 'issuing'): void {
    const ph = r.handoff!.phase as Phase;
    if (r.steps[PHASES.indexOf(ph)]!.state === 'attention') this.step(r, ph, 'now');
    r.handoff = null;
    r.turn = null;
    r.status = status;
    this.emit('update', r);
  }

  /**
   * 승인 바에서 승인했다(근거를 게이트 포트로 보내기 직전에 부른다). 거부 우선 창(2초) 동안은 [중지]가 이긴다.
   * 보낸 뒤 엔진이 끝나면 발급됐는지 모르는 쪽으로 다룬다(engineGone).
   */
  approved(runId: string, noteText = '승인했어요. 2초 안에 [중지]하면 발급하지 않아요'): void {
    const r = this.runs.get(runId);
    if (!r || r.status !== 'waiting') return;
    r.approvedPending = true;
    this.step(r, 'gate', 'now', noteText);
    this.emit('update', r);
  }

  /**
   * 게이트 답의 결과를 실행에 반영한다. "발급 없음"이라고 말할 수 있는 것은 엔진이 판정했거나 보내지 않았을 때뿐이다.
   * 보낸 뒤 판정을 못 받았으면(엔진·금고 종료) 승인 표시를 그대로 둔다. 엔진 종료 처리가 발급됐는지 모름으로 끝낸다.
   */
  async onAnswer(runId: string, r: GateAnswerResult): Promise<void> {
    if (r.ok || r.verdict === 'unknown') return;
    // [중지]·대기 만료가 먼저 게이트를 닫았으면(경쟁) 엔진이 그 이유로 실행을 끝낸다. 이유를 덮지 않는다.
    if (r.verdict === 'engine' && RACED.has(r.code ?? '')) return this.answerNotTaken(runId);
    await this.abortGate(runId, 'answer.rejected');
  }

  /**
   * 엔진이 근거를 받지 않았다(토큰 없음, 발급 없음). "승인했어요" 안내를 바로 거둔다. [중지]·만료가 먼저 게이트를
   * 닫은 경우(경쟁)도 여기까지만 한다. 끝 이유는 엔진의 것(중지·만료)이 맞다.
   */
  answerNotTaken(runId: string, note = '승인이 반영되지 않았어요'): void {
    const r = this.runs.get(runId);
    if (!r || r.status !== 'waiting') return;
    r.approvedPending = false;
    this.step(r, 'gate', 'now', note);
    this.emit('update', r);
  }

  /** 승인 근거를 엔진이 거부했거나 바를 띄우지 못했다. 열린 게이트를 중지로 닫는다(안전한 실패). */
  async abortGate(runId: string, code: string): Promise<void> {
    if (!this.runs.has(runId)) return;
    this.answerNotTaken(runId, '승인을 전하지 못해 멈추고 있어요');
    this.endCodes.set(runId, code);
    await this.host.rpc('run.stop', { runId }).catch(() => {});
  }

  private step(r: RunView, phase: Phase, state: StepState, noteText?: string): void {
    const i = PHASES.indexOf(phase);
    const label = STEP_LABELS[r.doc][i];
    // 그 서류에 없는 단계(민원증명의 메일)는 그리지 않는다
    if (label !== undefined) r.steps[i] = { label, state, note: noteText };
  }

  private onEngine(e: EngineEvent): void {
    const r = this.runs.get(e.runId);
    if (!r) return;
    if (e.type === 'phase') {
      // 서명 단계: 엔진이 확인 창·인증유형(프로필 발급 인증)을 누르고 나면 사람 몫이다(인증서 비밀번호·간편인증 승인, 2026-11-11 실화면).
      // 엔진의 서명 차례(handoff)는 끝 표지를 기다린 뒤에야 오므로, 할 일은 서명 단계에 들어설 때 바로 보인다.
      // 민원증명의 승인 뒤 단계는 사람 몫이 없는 제출(s21)이라 인증 안내를 붙이지 않는다.
      const n = e.phase === 'sign' && e.state === 'now' ? (r.cert ? undefined : (signFor(r.auth)?.now ?? SIGN_NOW_DEFAULT)) : e.phase === 'login' && e.state === 'now' ? LOGIN_NOW : e.code ? NOTE[e.code] : undefined;
      this.step(r, e.phase, e.state === 'attention' ? 'attention' : e.state, n);
      // 발급목록 조회 횟수(08 §11 "확인 중 · 조회 n회째"). 엔진이 attempt를 보낼 때만.
      if (e.phase === 'verify' && Number.isSafeInteger(e.attempt) && e.attempt! > 0) r.verifyAttempt = e.attempt;
      if (['sign', 'verify', 'mail'].includes(e.phase) && r.status === 'waiting') {
        r.status = 'issuing';
        r.approvedPending = false;
        this.step(r, 'gate', 'done');
      }
      this.emit('update', r);
      return;
    }
    if (e.type === 'waiting') return; // 게이트 요청(게이트 포트)이 따로 온다
    if (e.type === 'state') return this.onState(r, e);
    if (e.type === 'regate') {
      if (!isRegate(e.reason) || !['preparing', 'turn', 'waiting'].includes(r.status)) return;
      r.regate = { reason: e.reason, note: REGATE_NOTE[e.reason] };
      this.emit('update', r);
      return;
    }
    if (e.type === 'handoff') {
      if (!PHASES.includes(e.phase) || !['preparing', 'turn', 'issuing'].includes(r.status)) return;
      const i = PHASES.indexOf(e.phase);
      const t = handoffTurn(e.phase, e.code, r.auth, STEP_LABELS[r.doc]);
      r.status = 'turn';
      r.handoff = { phase: e.phase, afterGate: i > PHASES.indexOf('gate'), kind: t.kind };
      r.turn = { text: t.text, note: t.note };
      this.step(r, e.phase, 'attention', t.kind === 'sign' ? '홈택스 창에서 서명 중' : '직접 해 주세요');
      this.emit('update', r);
      return;
    }
    if (e.type === 'secret') {
      // 인증서 비밀번호 차례: 앱 금고 창이 뜬다(main openSecret). 실행은 계속된다. 지금 단계에 할 일만 적는다.
      if (e.state !== 'open' || !['preparing', 'turn', 'issuing'].includes(r.status)) return;
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, note: '앱에 뜬 창에 인증서 비밀번호를 넣어 주세요' };
      this.emit('update', r);
      return;
    }
    if (e.type === 'notice') {
      // 포털 대화상자(사업자번호 [확인]의 alert 등)는 팝업 없이 지금 단계 아래 한 줄 글로 보인다. 기대와 다르면 빨간 글(ok false).
      const text = typeof e.text === 'string' ? cleanNotice(e.text) : '';
      if (!text || !['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)) return;
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      const line = { step: now >= 0 ? now : PHASES.indexOf('input'), text: `${NOTICE_LABEL[e.key ?? ''] ?? '홈택스 안내'}: ${text}`, ok: e.ok === true };
      r.portalChecks = [...(r.portalChecks ?? []).filter((c) => c.text !== line.text), line];
      this.emit('update', r);
      return;
    }
    // 끝은 end 이벤트로만 안다. 모르는 이벤트(새 종류)로 실행을 끝내지 않는다(실화면 run-837dad14: secret 이벤트로 끝내 비밀번호 창이 닫혔다)
    if (e.type !== 'end') return this.src.log?.('main.run_event_ignored', { type: String((e as { type?: unknown }).type).slice(0, 40) });
    this.end(r, e);
  }

  /**
   * 엔진 상태 이벤트. 셸은 상태를 미리 가정하지 않고 이것만 따른다(증언 계약 수정 3).
   * - in_doubt: 확인 필요 카드(InDoubt). 실행은 끝나지 않았다(금고 실행·증언 요청이 이어진다).
   * - running: InDoubt·멈춤에서 다시 돌기 시작했다(되감기). 게이트 앞부터 다시 돌고 새 게이트 요청이 온다. 앞의 승인은 쓰지 않는다.
   * - paused: 멈춤(정지 하향 등). 확인 필요로 보이고 이유 문구를 둔다.
   * 나머지(waiting_gate·waiting_human·recovering·handed_off·interrupted)는 지금 다른 이벤트(gate·handoff·phase)로 보인다(M2-2).
   */
  private onState(r: RunView, e: { state: RunState; code?: string; portalNotice?: string }): void {
    // attention은 끝난 실패 카드에도 쓴다. InDoubt·멈춤 상태로 들어와 있는 실행만 살아 있는 attention이다.
    const live = this.liveInDoubt.has(r.id) || this.paused.has(r.id);
    if (!RUN_STATES.includes(e.state) || ['draft', 'done', 'stopped'].includes(r.status) || (r.status === 'attention' && !live)) return;
    if (typeof e.portalNotice === 'string' && e.portalNotice.trim()) r.notices = [...new Set([...(r.notices ?? []), portalNoticeText(e.portalNotice)])];
    if (e.state === 'in_doubt') {
      this.liveInDoubt.add(r.id);
      r.turn = null;
      r.approvedPending = false;
      r.handoff = null;
      r.inDoubt = true;
      r.status = 'attention';
      r.stoppedNote = note(IN_DOUBT_NOTE.has(e.code ?? '') ? e.code : BLOCK_CODES.has(e.code ?? '') ? 'portal.blocked_in_doubt' : 'in_doubt', r);
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, state: 'attention' };
    } else if (e.state === 'running') {
      // InDoubt·멈춤에서만 되살린다(진행 중인 실행의 running은 단계 이벤트가 이미 보인다).
      if (!this.liveInDoubt.has(r.id) && !this.paused.has(r.id)) return;
      this.liveInDoubt.delete(r.id);
      this.paused.delete(r.id);
      r.inDoubt = false;
      r.attest = null;
      r.stoppedNote = undefined;
      r.status = 'preparing';
      r.confirmed = false;
      // 게이트 앞부터 다시 돈다: 게이트와 그 뒤 단계는 아직 안 한 것으로 되돌린다.
      for (const p of ['gate', 'sign', 'verify', 'mail'] as const) this.step(r, p, 'todo');
    } else if (e.state === 'paused') {
      this.liveInDoubt.delete(r.id);
      this.paused.add(r.id);
      r.inDoubt = false;
      r.turn = null;
      r.status = 'attention';
      r.stoppedNote = note(e.code ?? 'run.paused', r);
    } else return;
    this.emit('update', r);
  }

  private end(r: RunView, e: { status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string; maintenanceUntil?: string; until?: string }): void {
    // InDoubt·멈춤(state)은 확인 필요로 보이지만 끝난 것이 아니다. 그 뒤의 end(completed_with_issues 등)는 받는다.
    const live = this.liveInDoubt.delete(r.id) || this.paused.delete(r.id);
    if (!live && ['draft', 'done', 'stopped', 'attention'].includes(r.status)) return;
    if (live) {
      r.inDoubt = false;
      r.attest = null;
    }
    void this.host.control('run.end', { runId: r.id }).catch(() => {});
    // 승인했거나 게이트 뒤 단계였는가(engineGone의 unsure와 같은 판단). 핸드오프 끝 문구가 "발급하지 않았어요"를 말해도 되는지 가른다.
    const pastGate = r.status === 'issuing' || r.approvedPending === true || r.handoff?.afterGate === true;
    r.turn = null;
    r.handoff = null;
    r.approvedPending = false;
    // 게이트에 닿은 예행은 승인 카드가 뜬 실행처럼 센다(엔진이 게이트 요청을 main에 보내지 않는다).
    if (r.rehearsal && e.code === 'rehearsal.gate_reached') this.gateless = [];
    else if (!r.confirmed) this.gateless.push(this.clock());
    if (typeof e.portalNotice === 'string' && e.portalNotice.trim()) r.notices = [...(r.notices ?? []), portalNoticeText(e.portalNotice)];
    // in_doubt는 main이 닫은 이유("아무것도 발급하지 않았어요")로 덮지 않는다. 발급됐는지 모른다는 것이 먼저다.
    const code = e.status === 'in_doubt' ? (IN_DOUBT_NOTE.has(e.code ?? '') ? e.code : BLOCK_CODES.has(e.code ?? '') ? 'portal.blocked_in_doubt' : 'in_doubt') : (this.endCodes.get(r.id) ?? e.code);
    this.endCodes.delete(r.id);
    this.src.log?.('main.run_end', { status: e.status, code: (code ?? 'none').slice(0, 80) });
    if ((e.status === 'success' || e.status === 'completed_with_issues') && (e.approvalNo || r.cert)) {
      const doc = issuedDoc(r);
      r.status = 'done';
      // 엔진은 끝 스텝에서 마지막 구간의 done을 따로 보내지 않는다. 확정된 실행에서 진행 중이던 단계는 끝난 것이다.
      r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'done' } : s));
      // 발급 PDF는 엔진이 보관함에 실행 산출물(run_id)로 남긴다(#269). 메모리 줄(d-<runId>)은 그 PDF가 없을 때만 문서함에 보이므로 늘 noFile이다.
      // 결과 카드는 PDF 보관이 실패했을 때(save_pdf.failed)만 [PDF 열기] 대신 홈택스 발급목록 안내(F-04). 열기는 렌더러가 run_id로 보관함 줄을 찾는다.
      r.result = { approvalNo: e.approvalNo ?? '', mailTo: r.email.value, docId: doc.id, doneAt: hm(), mailConfirmed: e.mailConfirmed === true, noFile: e.code === 'save_pdf.failed' };
      if (!r.cert && !e.mailConfirmed) {
        this.step(r, 'mail', 'attention', r.email.value ? NOTE['mail.not_confirmed'] : '받는 이메일이 없어 보내지 않았어요');
        if (r.email.value) r.warnings = [NOTE['mail.not_confirmed']!];
      }
      if (e.code === 'portal.blocked_after_commit') r.warnings = [...r.warnings, NOTE['portal.blocked_after_commit']!];
      if (e.code === 'save_pdf.failed') r.warnings = [...r.warnings, note('save_pdf.failed', r)];
      this.emit('doc', doc);
    } else if (e.status === 'stopped' || e.status === 'expired') {
      r.status = 'stopped';
      r.stoppedNote = note(code, r);
    } else {
      // 실패·in_doubt는 사용자가 볼 일이 있다(확인 필요). 지금 단계를 표시하고 이유를 보인다.
      r.status = 'attention';
      r.stoppedNote = note(code, r);
      r.inDoubt = e.status === 'in_doubt';
      // 승인 전 핸드오프로 끝남: "확인 필요"만 남지 않게 무슨 일인지와 다음 할 일(다시 준비 / 홈택스에서 직접)을 말한다. 승인·게이트 뒤면 발급 여부를 단정하지 않는다(엔진 코드 문구 그대로).
      // 발급 전 단계에서 끝났으면 같은 값으로 다시 준비할 수 있다(in_doubt·게이트 뒤는 아님: 기존 문구·확인 길 그대로)
      r.redo = !r.inDoubt && !pastGate;
      if (code === MAINTENANCE_CODE && !r.inDoubt && !pastGate) this.maintenanceEnd(r, e.maintenanceUntil ?? e.until);
      else if (e.status === 'handoff' && !pastGate) {
        r.handoffEnd = true;
        const base = code && NOTE[code] ? NOTE[code]! : HANDOFF_END_NOTE;
        r.stoppedNote = `${base}${/아무것도 발급하지 않았어요/.test(base) ? '' : ' 아무것도 발급하지 않았어요.'} ${HANDOFF_END_NEXT}`;
      }
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, state: 'attention' };
    }
    r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'todo', note: undefined } : s));
    r.endedAt = this.clock();
    // 브라우저가 닫혀 끝난 제출 전 실행(멈춤·연결 끊김 실패 어느 쪽이든): 같은 문구와 [다시 시작]
    if (!r.result && !r.inDoubt && !pastGate && (r.browserClosed || this.clock() - this.goneAt < 10_000)) this.markClosed(r);
    this.batchAfter(r, code);
    this.emit('update', r);
    this.wakeAfter(r, code);
  }

  /**
   * 엔진 run.reverify가 홈택스 발급목록에서 이 실행의 발급을 찾았다(원장 committed, 승인번호). 끝난 확인 필요(in_doubt) 카드만 발급 완료로 바꾼다.
   * 받는 사람 메일 발송은 확인하지 않았다(이메일이 있으면 그 경고). PDF는 보관하지 않았다. 문서함 줄은 end의 발급 완료와 같다.
   */
  reverified(runId: string, approvalNo: string): void {
    const r = this.runs.get(runId);
    if (!r || !r.inDoubt || r.status !== 'attention' || this.liveInDoubt.has(r.id)) return;
    r.inDoubt = false;
    r.attest = null;
    r.status = 'done';
    r.stoppedNote = undefined;
    r.steps = r.steps.map((s) => (s.state === 'attention' ? { ...s, state: 'done', note: undefined } : s));
    const doc = issuedDoc(r);
    r.result = { approvalNo, mailTo: r.email.value, docId: doc.id, doneAt: hm(), mailConfirmed: false, noFile: true };
    if (r.email.value) r.warnings = [NOTE['mail.not_confirmed']!];
    this.emit('doc', doc);
    this.emit('update', r);
  }

  /** 게이트 요청: 카드·패널은 엔진이 되읽은 값(같은 fields)으로 바꿔 그린다. 바는 shell-app이 띄운다. */
  private onGate(req: GateRequest): void {
    const r = this.runs.get(req.runId);
    if (!r || !['preparing', 'turn'].includes(r.status)) return;
    const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
    if (r.cert) {
      // 민원증명: 엔진이 되읽은 용도·제출처(승인 카드 4칸과 같은 fields)를 카드·패널에 보인다. 세금계산서 칸은 건드리지 않는다.
      const before = `${r.cert.inputs.purpose}|${r.cert.inputs.submitTo}`;
      r.cert = { ...r.cert, inputs: { ...r.cert.inputs, purpose: f.get('certPurpose') ?? '', submitTo: f.get('certSubmitTo') ?? '' } };
      r.readbackDiffers = before !== `${r.cert.inputs.purpose}|${r.cert.inputs.submitTo}`;
      r.warnings = dupWarnings(req, CERT_DUP_NOTE);
      return this.gateOpened(r, req);
    }
    const num = (k: string) => Number(f.get(k as never) ?? NaN);
    const before = { name: r.counterparty.name, bizNo: r.counterparty.bizNo, email: r.email.value, supply: r.supply, tax: r.tax, item: r.item };
    r.counterparty = { ...r.counterparty, name: f.get('counterpartName') ?? '', bizNo: f.get('counterpartBizNo') ?? '', first: f.get('$first.bizNo') === 'true' };
    r.email = { value: f.get('counterpartEmail') ?? '', first: f.get('$first.email') === 'true' };
    r.supply = num('supplyAmount');
    r.tax = num('taxAmount');
    r.total = num('totalAmount');
    r.item = f.get('itemName') ?? '';
    r.writeDate = f.get('issueDate') ?? r.writeDate;
    const after = { name: r.counterparty.name, bizNo: r.counterparty.bizNo, email: r.email.value, supply: r.supply, tax: r.tax, item: r.item };
    r.readbackDiffers = JSON.stringify(before) !== JSON.stringify(after);
    r.warnings = dupWarnings(req);
    this.gateOpened(r, req);
  }

  private gateOpened(r: RunView, req: GateRequest): void {
    r.confirmed = true;
    r.action = actionText(req);
    this.gateless = [];
    r.status = 'waiting';
    for (const p of ['login', 'form', 'input', 'readback'] as const) if (r.steps[PHASES.indexOf(p)]!.state !== 'done') this.step(r, p, 'done');
    this.step(r, 'gate', 'now', '아래 [승인하고 발급]을 기다려요');
    this.emit('update', r);
    this.emit('gate', r.id, req);
  }
}
