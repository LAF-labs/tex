// D03 §7.1 앱 내장 상한·하한(앱 업데이트로만 바뀐다). 정책·패키지·레지스트리로 바꿀 수 없다.
import type { CaptchaRelay, Portal, PortalMode } from './types.ts';

export const PORTAL_MODE_CEILING: Readonly<Record<Portal, PortalMode>> = Object.freeze({
  hometax: 'auto',
  gov24: 'postprocess',
  wetax: 'postprocess',
  sminfo: 'postprocess',
  insure4: 'postprocess',
  iros: 'postprocess',
  public_api: 'postprocess',
});

export const CAPTCHA_RELAY_CEILING: Readonly<Record<Portal, CaptchaRelay>> = Object.freeze({
  hometax: 'allowed',
  gov24: 'disabled_until_permission',
  wetax: 'disabled_until_permission',
  sminfo: 'disabled_until_permission',
  insure4: 'disabled_until_permission',
  iros: 'disabled_until_permission',
  public_api: 'disabled_until_permission',
});

/** 낮을수록 보수적. */
export const MODE_ORDER: Readonly<Record<PortalMode, number>> = { postprocess: 0, assisted: 1, auto: 2 };
export const CAPTCHA_ORDER: Readonly<Record<CaptchaRelay, number>> = { disabled: 0, disabled_until_permission: 1, allowed: 2 };

export const POLICY_FLOOR = Object.freeze({
  stepDelayMsMin: 800,
  afterNavSettleMsMin: 600,
  onBlockSignalHoursMin: 24,
  positiveDetectionsForCooldownMax: 2,
  onCaptchaBurstCountMax: 3,
  onCaptchaBurstWindowMinMin: 10,
  commitWindowMsMax: 900_000,
  l2MaxAttemptsMax: 2,
  remoteIrreversiblePerDayMax: 5,
  queueMaxIntentsPerPairMax: 5,
  queueTtlHoursMax: 72,
  verifyMinElapsedMsMin: 30_000,
  verifyLookupsMin: 2,
  verifyMaxMsMin: 300_000,
  loginFailuresPerDayMax: 2,
});

/** 승인·진행 동작 이름(NFKC·제로폭 제거·공백 제거 뒤). 팝업 닫기·L2 수리·커밋 그림자 검사가 쓴다(B-32). */
export const DENY_ACTION_NAME = /(확인|예|네|발급|제출|전송|동의|신청|승인|저장|등록|계속|다음|진행|서명|결제|삭제|ok|yes|confirm|submit|send|issue|apply|agree|next|continue)/i;

/** SV-02 이름 린트: 이 이름의 button·link·menuitem이 commits:false이면 reviewNote 필수. */
export const COMMIT_NAME_LINT = /발급|제출|신청|전송|서명|승인|저장|등록|삭제|취소|확인|계속|다음/;

export const POLICY_MAX_VALIDITY_H = 72;
export const TIMESTAMP_RESIGN_H = 48;
export const POLICY_STALE_FALLBACK_H = 168;
export const ISSUED_AT_MAX_SKEW_MIN = 5;
export const EMERGENCY_STATUS_TTL_H = 72;
export const INDEX_MAX_VALIDITY_D = 14;
export const HOTFIX_MAX_VALIDITY_D = 14;
export const VERSION_JUMP_MAX = 1000;
export const STATUS_MAX_AGE_H = 48;
export const STATUS_STALE_DAEMON_STOP_H = 72;
export const W_STATIC_BOUND_MS = 60_000;
export const POLICY_POLL_MIN = 15;
export const POLICY_PRERUN_RECHECK_MIN = 5;
export const POLICY_PRERUN_WAIT_MS = 3_000;
export const MAX_ACTUATIONS_DEFAULT = 150;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** R-A1·L2 (5): NFKC + 제로폭 제거 + 공백 접기. namePattern 대조용. */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** DENY_ACTION_NAME 대조용: NFKC + 제로폭 제거 + 공백 제거(B-32). */
export function denyKey(s: string): string {
  return s.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, '');
}

export const isDenyActionName = (name: string): boolean => DENY_ACTION_NAME.test(denyKey(name));
