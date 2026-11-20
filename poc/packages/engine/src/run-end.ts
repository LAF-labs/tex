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
  beforeStep(): Promise<void>;
  act(kind: 'navigate' | 'click' | 'fill'): Promise<void>;
  settled(page: Page): Promise<void>;
  beforeGate(): Promise<void>;
  beforeCommit(): Promise<void>;
  halted(): RunEnd | null;
  reached(): void;
}
