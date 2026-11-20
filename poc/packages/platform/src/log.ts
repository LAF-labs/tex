import fs from 'node:fs';
import path from 'node:path';

export type LogFields = Record<string, string | number | boolean | undefined>;

/** 진단 데이터(diag): 객체·배열·원시값. 문자열은 diagSafe로 다시 거른다. */
export type DiagValue = string | number | boolean | null | DiagValue[] | { [k: string]: DiagValue };

export interface EventLog {
  event(code: string, fields?: LogFields): void;
  diag?(code: string, fields: LogFields, data: DiagValue): void;
}

const DIAG_KEY = /^[A-Za-z0-9_]{1,40}$/;
const DIAG_IDENT_KEYS = new Set(['id', 'candidate', 'selector', 'namePattern', 'key', 'target', 'stepId', 'checkpoint']);
/** 진단 문자열 거르기(로그 쪽 마지막 그물). ident면 숫자는 두고 나머지만 거른다. */
export function diagText(s: string, ident = false): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '[EMAIL]');
  return (ident ? t : t.replace(/\d{4,}/g, '#')).slice(0, 120);
}
export function diagSafe(v: DiagValue, depth = 0, key = ''): DiagValue {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return diagText(v, DIAG_IDENT_KEYS.has(key));
  if (depth >= 6) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => diagSafe(x, depth + 1));
  const o: { [k: string]: DiagValue } = {};
  for (const [k, x] of Object.entries(v)) if (DIAG_KEY.test(k) && x !== undefined) o[k] = diagSafe(x, depth + 1, k);
  return o;
}

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,80}$/;
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
