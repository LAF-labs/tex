import fs from 'node:fs/promises';
import path from 'node:path';

// 비밀 누출 스캐너(D13 §6, D05 §8). 테스트 비밀 패턴과 인코딩 변형을 캡처·로그·디스크에서 찾는다.

export interface Variant {
  name: string;
  bytes: Buffer;
}

export interface LeakFinding {
  source: string;
  variant: string;
  secret: string;
}

/** 테스트 비밀 생성기: 실제 비밀과 겹치지 않게 고정 접두사 + 무작위. */
export function testSecret(prefix = 'TEST-CERT'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function variantsOf(secret: string): Variant[] {
  const s = Buffer.from(secret, 'utf8');
  const out: Variant[] = [
    { name: 'utf8', bytes: s },
    { name: 'utf16le', bytes: Buffer.from(secret, 'utf16le') },
    { name: 'json', bytes: Buffer.from(JSON.stringify(secret).slice(1, -1)) },
    { name: 'url', bytes: Buffer.from(encodeURIComponent(secret)) },
    { name: 'hex', bytes: Buffer.from(s.toString('hex')) },
    { name: 'HEX', bytes: Buffer.from(s.toString('hex').toUpperCase()) },
  ];
  // base64는 앞 바이트 정렬에 따라 달라지므로 세 정렬의 안정된 중간 부분을 찾는다.
  for (let k = 0; k < 3; k++) {
    const b = Buffer.concat([Buffer.alloc(k), s]).toString('base64');
    const core = b.slice(k === 0 ? 0 : 4, b.length - 4);
    if (core.length >= 8) {
      out.push({ name: `base64@${k}`, bytes: Buffer.from(core) });
      out.push({ name: `base64url@${k}`, bytes: Buffer.from(core.replace(/\+/g, '-').replace(/\//g, '_')) });
    }
  }
  return out;
}

export function scanBuffer(source: string, data: Buffer, secrets: string[]): LeakFinding[] {
  const found: LeakFinding[] = [];
  for (const secret of secrets) {
    for (const v of variantsOf(secret)) {
      if (data.includes(v.bytes)) found.push({ source, variant: v.name, secret: mask(secret) });
    }
  }
  return found;
}

function mask(secret: string): string {
  return secret.slice(0, 10) + '…';
}

/** 메모리 캡처(IPC·엔진 수신 CDP·렌더러 DOM 등). */
export class LeakCapture {
  private readonly chunks: Array<{ source: string; text: string }> = [];

  add(source: string, data: unknown): void {
    const text = typeof data === 'string' ? data : stringify(data);
    this.chunks.push({ source, text });
  }

  get size(): number {
    return this.chunks.length;
  }

  bySource(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const c of this.chunks) r[c.source] = (r[c.source] ?? 0) + 1;
    return r;
  }

  scan(secrets: string[]): LeakFinding[] {
    const bySource = new Map<string, string[]>();
    for (const c of this.chunks) {
      const arr = bySource.get(c.source) ?? [];
      arr.push(c.text);
      bySource.set(c.source, arr);
    }
    const out: LeakFinding[] = [];
    for (const [source, texts] of bySource) out.push(...scanBuffer(source, Buffer.from(texts.join('\n'), 'utf8'), secrets));
    return out;
  }
}

function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));
}

/** 디스크(로그 폴더·전용 Chrome 프로필·staging 등)를 재귀로 훑는다. 큰 파일은 건너뛰고 개수를 보고한다. */
export async function scanDir(dir: string, secrets: string[], maxBytes = 64 * 1024 * 1024): Promise<{ findings: LeakFinding[]; files: number; skipped: number }> {
  let files = 0;
  let skipped = 0;
  const findings: LeakFinding[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const st = await fs.stat(p).catch(() => null);
        if (!st) continue;
        if (st.size > maxBytes) {
          skipped++;
          continue;
        }
        const buf = await fs.readFile(p).catch(() => null);
        if (!buf) continue;
        files++;
        findings.push(...scanBuffer(path.relative(dir, p), buf, secrets));
      }
    }
  };
  await walk(dir);
  return { findings, files, skipped };
}
