import fs from 'node:fs';
import path from 'node:path';

// D05 §8·D12: 로그에는 결과 코드와 ID만 남긴다. 값 필드는 받지 않는다.
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface EventLog {
  event(code: string, fields?: LogFields): void;
}

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,80}$/;

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
      safe[k] = typeof v === 'string' && !SAFE_VALUE.test(v) ? '[dropped]' : v;
    }
    const line = JSON.stringify({ at: new Date().toISOString(), c: this.component, code, ...safe });
    this.lines.push(line);
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
    } catch {
      // 로그 폴더가 사라졌으면(종료 중) 메모리 기록만 남긴다
    }
  }
}
