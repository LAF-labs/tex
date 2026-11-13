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
  /** 입력할 수 있는가(readonly·disabled 아님, IR rev v1.3.6 expect.editable). 구현이 모르면 없다(그러면 editable 항목은 받지 않는다). */
  editable?: boolean;
}

/** 판정·에이전트가 보는 상호작용 역할. */
export const INTERACTIVE_ROLES = ['textbox', 'combobox', 'checkbox', 'radio', 'button', 'link', 'tab'] as const;

export interface InteractiveElement {
  el: ElementRef;
  role: string;
  name: string;
  id: string | null;
  enabled: boolean;
  /** 입력 칸에 값이 있는가(값은 읽지 않는다). 입력 칸이 아니면 false. */
  filled: boolean;
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
  /**
   * frame 안의 이 역할 요소 전부: 접근성 이름·DOM id·보임·활성만(AI 위치 찾기, core/locate.ts). 입력값은 읽지 않는다. 비밀번호 칸은 뺀다.
   * 구현이 없으면 AI 위치 찾기를 쓰지 않는다.
   */
  listRole?(frame: string, role: string): Promise<Array<{ el: ElementRef; name: string; id: string | null; visible: boolean; enabled: boolean }>>;
  /**
   * 판정·브라우저 에이전트용: 프레임의 상호작용 요소(INTERACTIVE_ROLES) 중 보이는 것. 값은 읽지 않고 입력 칸이 채워졌는지(filled)만 본다.
   * 비밀번호 칸은 넣지 않는다. 구현이 없으면 판정·에이전트를 쓰지 않는다.
   */
  listInteractive?(frame: string): Promise<InteractiveElement[]>;
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
  /**
   * 목록 항목(rows, IR rev v1.3.6 pick)의 행 하나를 누른다. t는 목록 항목, row는 그 하위 행(PageReader.query로 잡은 것).
   * GuardedActuator는 목록 항목을 R-A1로 다시 확인하고 row가 지금 그 목록의 행인지 본 뒤 원시 click을 부른다.
   */
  pickRow?(t: Resolved, row: ElementRef): Promise<ActResult>;
  /** 마지막 동작을 시작한 뒤 뜬(정책대로 이미 닫은) 네이티브 대화상자(wait for:'dialog'). GuardedActuator만 구현한다. */
  dialogSinceAction?(): { kind: string; notice: string } | null;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
