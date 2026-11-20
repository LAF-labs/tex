import fs from 'node:fs/promises';
import path from 'node:path';

const POC = path.resolve(import.meta.dirname, '..');
export const COMMITTED_DIR = path.join(POC, 'reports', 'raw');
export const LOCAL_DIR = path.join(COMMITTED_DIR, '.local');

export function measureRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SAX_MEASURE_COMMIT === '1') return COMMITTED_DIR;
  if (env.SAX_MEASURE_DIR) return path.resolve(env.SAX_MEASURE_DIR);
  return LOCAL_DIR;
}

export function measurePath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = measureRoot(env);
  const p = path.resolve(root, name);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`측정 파일 이름이 출력 폴더 밖을 가리킨다: ${name}`);
  return p;
}

export async function writeMeasure(name: string, data: unknown): Promise<string> {
  const p = measurePath(name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

const started = new Set<string>();
export async function appendMeasure(name: string, row: unknown): Promise<string> {
  const p = measurePath(name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const line = (typeof row === 'string' ? row : JSON.stringify(row)) + '\n';
  if (started.has(p)) await fs.appendFile(p, line);
  else {
    started.add(p);
    await fs.writeFile(p, line);
  }
  return p;
}
