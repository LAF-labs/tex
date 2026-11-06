// 스텝 핸들러가 페이지에 닿는 두 포트(D03 §5.1·§5.2). 핸들러는 Playwright를 직접 쓰지 않는다.
// - PageReader: 읽기 전용(요소 찾기·속성·텍스트·값·대기). 페이지를 바꾸지 않는다.
// - Actuator: 페이지를 바꾸는 모든 동작의 단일 통로. 정책 집행(지연·카운터·쿨다운·상한), R-A1 재확인, R-A2 커밋 충돌, 커밋 그림자 검사는
//   GuardedActuator(actuator.ts, M2-4)가 원시 드라이버를 감싸 한다. 핸들러는 동작 전에 resolveTarget으로 R-A1을 한 번 확인하고,
//   GuardedActuator가 동작 직전에 다시 확인한다.
import type { Candidate, PressStep, SelectorEntry } from './types.ts';

/** 페이지 위 요소 하나를 가리키는 불투명 값. 안은 포트 구현만 안다. */
export interface ElementRef {
  readonly ref: string;
}

export interface ElementInfo {
  /** 접근성 역할. */
  role: string;
  /** 접근성 이름(정규화 전). */
  name: string;
  visible: boolean;
  enabled: boolean;
}

export interface PageReader {
  url(): string;
  /** frame 안(within이 있으면 그 요소의 하위)에서 후보에 맞는 요소 전부. */
  query(c: Candidate, frame: string, within: ElementRef | null): Promise<ElementRef[]>;
  info(el: ElementRef): Promise<ElementInfo>;
  /** 두 참조가 같은 DOM 요소인가(R-A2 커밋 충돌 검사). */
  same(a: ElementRef, b: ElementRef): Promise<boolean>;
  /** 보이는 텍스트(innerText). */
  text(el: ElementRef): Promise<string>;
  /** 입력 요소의 DOM value(CDP 읽기 전용 함수, D02 §2.1). */
  value(el: ElementRef): Promise<string>;
  /** 접근성 트리의 값. */
  a11yValue(el: ElementRef): Promise<string>;
  /** 주 프레임의 보이는 텍스트. */
  bodyText(): Promise<string>;
  /** 다음 네비게이션 완료까지 기다린다. 시간 안에 오면 true. */
  waitNavigation(timeoutMs: number): Promise<boolean>;
  /** 네트워크·DOM이 잠잠해질 때까지 기다린다. 시간 안에 오면 true. */
  waitIdle(timeoutMs: number): Promise<boolean>;
}

/** 사전 항목 하나를 해석한 결과. */
export interface Resolved {
  key: string;
  entry: SelectorEntry;
  el: ElementRef;
}

export type ActResult = { ok: true } | { ok: false; code: string };

export interface Actuator {
  /** 이동 후 로드 대기까지. */
  goto(url: string): Promise<ActResult>;
  click(t: Resolved): Promise<ActResult>;
  /** 기존 값을 지우고 입력한다. keyEvents면 전체 선택 → 삭제 → 고정 간격 키 입력(D03 §5.5). */
  fill(t: Resolved, value: string, o: { keyEvents: boolean }): Promise<ActResult>;
  /** 칸을 비운다(ifAbsent: clear, B-05). */
  clear(t: Resolved): Promise<ActResult>;
  select(t: Resolved, option: string): Promise<ActResult>;
  press(key: PressStep['key'], t: Resolved | null): Promise<ActResult>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
