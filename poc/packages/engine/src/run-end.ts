// 실행 종료 신호·요청률 정책 포트(제품 모듈). PoC H-01 실행기(h01/runner.ts)에서 옮겼다(동작 변화 없음, ADR-035 승격 점검 (라) 준비).
// 엔진 진입점·정책 집행기·실행 서비스가 쓰고, H-01 실행기도 여기서 가져온다.
import type { Page } from 'playwright-core';

export type RunStatus = 'success' | 'completed_with_issues' | 'failed' | 'handoff' | 'stopped' | 'expired' | 'in_doubt';

/** 실행이 끝났다(정상 종료가 아닌 경우도). code는 사용자 문구를 고르는 키다(값 없음). */
export class RunEnd extends Error {
  readonly status: RunStatus;
  readonly code: string;
  constructor(status: RunStatus, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface RunnerPolicy {
  /** 스텝 사이 지연(요청률 상한). [중지]를 받는다. */
  beforeStep(): Promise<void>;
  /** 동작 직전: 실행당 동작 수·벽시계, 네비게이션이면 분당 상한(증가 커밋 → 행동). */
  act(kind: 'navigate' | 'click' | 'fill'): Promise<void>;
  /** 네비게이션 뒤 안정 대기 + 그 화면의 차단 신호 확인. */
  settled(page: Page): Promise<void>;
  /** 게이트 진입 직전 판정(W 밖, D03 §5.3 사전 안전 판정): 결정적 차단 신호가 없어야 게이트를 연다. */
  beforeGate(): Promise<void>;
  /** 커밋 직전 판정(W 안, 결정적 신호·실행당 상한·분당 네비게이션). 바로 뒤에 hooks.arm()을 부른다. */
  beforeCommit(): Promise<void>;
  /** 걸쇠에 걸린 신호(없으면 null). 무장 뒤 클릭 직전에 동기로 본다. */
  halted(): RunEnd | null;
  /** 기대한 화면(체크포인트 도착 조건)을 확인했다. 차단 신호 연속을 끊는 '깨끗한 실행'의 조건이다. */
  reached(): void;
}
