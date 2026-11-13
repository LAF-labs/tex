import fs from 'node:fs';
import path from 'node:path';

// D05 §8·D12: 로그에는 결과 코드와 ID만 남긴다. 값 필드는 받지 않는다.
export type LogFields = Record<string, string | number | boolean | undefined>;

/** 진단 데이터(diag): 객체·배열·원시값. 문자열은 diagSafe로 다시 거른다. */
export type DiagValue = string | number | boolean | null | DiagValue[] | { [k: string]: DiagValue };

export interface EventLog {
  event(code: string, fields?: LogFields): void;
  /**
   * 진단 한 줄(실기기 원인 찾기): 화면 구조(태그·id·역할·접근성 이름·label·title·type)와 AI 단계 결과.
   * 부르는 쪽이 값을 넣지 않고 화면 글은 미리 가린다(engine core/diagnose.ts). 여기서는 한 번 더 거른다:
   * 제어 문자 제거, 이메일 가림, 4자리 이상 숫자 가림, 문자열 120자, 배열 60개, 깊이 6, 키는 이름 꼴만.
   */
  diag?(code: string, fields: LogFields, data: DiagValue): void;
}

const DIAG_KEY = /^[A-Za-z0-9_]{1,40}$/;
/** 진단 문자열 거르기(로그 쪽 마지막 그물). */
export function diagText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '[EMAIL]')
    .replace(/\d{4,}/g, '#')
    .slice(0, 120);
}
export function diagSafe(v: DiagValue, depth = 0): DiagValue {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return diagText(v);
  if (depth >= 6) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => diagSafe(x, depth + 1));
  const o: { [k: string]: DiagValue } = {};
  for (const [k, x] of Object.entries(v)) if (DIAG_KEY.test(k) && x !== undefined) o[k] = diagSafe(x, depth + 1);
  return o;
}

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,80}$/;
/** 줄 머리 키. 필드가 같은 이름이면 `<키>_`로 옮겨 적는다(예: main.engine_exit {code: 1}이 이벤트 이름을 덮어 `{"code":1}`만 남던 문제, WIN-REALDEVICE §7). */
const RESERVED = new Set(['at', 'c', 'code']);

export class FileEventLog implements EventLog {
  private readonly file: string;
  private readonly component: string;
  readonly lines: string[] = [];

  constructor(dir: string | null, component: string) {
    this.component = component;
    this.file = dir ? path.join(dir, `${component}.log`) : '';
  }

  event(code: string, fields: LogFields = {}): void {
    const safe: LogFields = {};
    for (const [k, v] of Object.entries(fields)) {
      // ID·코드 모양이 아닌 문자열은 기록하지 않는다(값 누출 방지).
      safe[RESERVED.has(k) ? `${k}_` : k] = typeof v === 'string' && !SAFE_VALUE.test(v) ? '[dropped]' : v;
    }
    this.write(JSON.stringify({ at: new Date().toISOString(), c: this.component, code, ...safe }));
  }

  diag(code: string, fields: LogFields, data: DiagValue): void {
    const safe: LogFields = {};
    for (const [k, v] of Object.entries(fields)) safe[RESERVED.has(k) ? `${k}_` : k] = typeof v === 'string' && !SAFE_VALUE.test(v) ? '[dropped]' : v;
    this.write(JSON.stringify({ at: new Date().toISOString(), c: this.component, code, ...safe, diag: diagSafe(data) }));
  }

  private write(line: string): void {
    this.lines.push(line);
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
    } catch {
      // 로그 폴더가 사라졌으면(종료 중) 메모리 기록만 남긴다
    }
  }
}
