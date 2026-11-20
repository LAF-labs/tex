import type { MaskedShot } from '@sax/model';
import type { Candidate, PressStep, SelectorEntry } from './types.ts';

/** 페이지 위 요소 하나를 가리키는 불투명 값. 안은 포트 구현만 안다. */
export interface ElementRef {
  readonly ref: string;
}

/**
 * 진단용 요소 모양(값 없음). name은 aria-label·label·title, 단추는 단추 글(input[type=button]의 value 포함)로 어림한 이름이다.
 * 입력 칸(text 등)의 value는 읽지 않는다. secret: 비밀번호 칸이거나 글자를 가리는 칸(-webkit-text-security).
 */
export interface ElementShape {
  tag: string;
  id: string | null;
  role: string | null;
  name: string;
  label: string;
  title: string;
  type: string | null;
  readonly: boolean;
  disabled: boolean;
  visible: boolean;
  secret: boolean;
}

export interface ElementInfo {
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  editable?: boolean;
  stale?: boolean;
}

/** 판정·에이전트가 보는 상호작용 역할. */
export const INTERACTIVE_ROLES = ['textbox', 'combobox', 'checkbox', 'radio', 'button', 'link', 'tab'] as const;

export interface InteractiveElement {
  el: ElementRef;
  role: string;
  name: string;
  id: string | null;
  enabled: boolean;
  filled: boolean;
}

export interface PageReader {
  url(): string;
  query(c: Candidate, frame: string, within: ElementRef | null): Promise<ElementRef[]>;
  info(el: ElementRef): Promise<ElementInfo>;
  same(a: ElementRef, b: ElementRef): Promise<boolean>;
  text(el: ElementRef): Promise<string>;
  value(el: ElementRef): Promise<string>;
  a11yValue(el: ElementRef): Promise<string>;
  bodyText(): Promise<string>;
  listRole?(frame: string, role: string): Promise<Array<{ el: ElementRef; name: string; id: string | null; visible: boolean; enabled: boolean }>>;
  listInteractive?(frame: string): Promise<InteractiveElement[]>;
  maskedShot?(): Promise<{ url: MaskedShot; width: number; height: number } | null>;
  box?(el: ElementRef): Promise<{ x: number; y: number; width: number; height: number } | null>;
  describe?(el: ElementRef): Promise<ElementShape | null>;
  describeRegion?(frame: string, within: ElementRef | null, max: number): Promise<ElementShape[]>;
  frameNames?(): string[];
  waitNavigation(timeoutMs: number): Promise<boolean>;
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
  goto(url: string): Promise<ActResult>;
  click(t: Resolved): Promise<ActResult>;
  fill(t: Resolved, value: string, o: { keyEvents: boolean }): Promise<ActResult>;
  clear(t: Resolved): Promise<ActResult>;
  select(t: Resolved, option: string): Promise<ActResult>;
  press(key: PressStep['key'], t: Resolved | null): Promise<ActResult>;
  pickRow?(t: Resolved, row: ElementRef): Promise<ActResult>;
  clickByBox?(t: Resolved): Promise<ActResult>;
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
