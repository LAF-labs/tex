// 측정 산출물 출력 위치(RETRO A-09, ADR-035 W-11). 테스트가 실행마다 추적 파일(reports/raw/*.json*)을 고쳐 작업 트리를 더럽히지 않게 한다.
//
// 출력 위치(앞이 우선):
//   1. SAX_MEASURE_COMMIT=1  → poc/reports/raw/       (추적 경로. 측정 결과를 의도해 갱신·커밋할 때만)
//   2. SAX_MEASURE_DIR=<경로> → 그 경로               (CI는 러너 임시 폴더로 보내 아티팩트로 올린다)
//   3. 기본                   → poc/reports/raw/.local/ (gitignore. 실행해도 git status가 깨끗하다)
//
// jsonl은 이어 쓰지 않는다: 한 프로세스에서 처음 쓸 때 비우고 그 실행의 줄만 남긴다(무한 누적 방지).
import fs from 'node:fs/promises';
import path from 'node:path';

const POC = path.resolve(import.meta.dirname, '..');
export const COMMITTED_DIR = path.join(POC, 'reports', 'raw');
export const LOCAL_DIR = path.join(COMMITTED_DIR, '.local');

/** 이번 실행의 측정 출력 폴더(절대 경로). 폴더를 만들지는 않는다. */
export function measureRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SAX_MEASURE_COMMIT === '1') return COMMITTED_DIR;
  if (env.SAX_MEASURE_DIR) return path.resolve(env.SAX_MEASURE_DIR);
  return LOCAL_DIR;
}

/** 측정 파일의 절대 경로. name은 measureRoot 아래 상대 경로(`poc-6/shell/x.json` 등)이고 바깥으로 나갈 수 없다. */
export function measurePath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = measureRoot(env);
  const p = path.resolve(root, name);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`측정 파일 이름이 출력 폴더 밖을 가리킨다: ${name}`);
  return p;
}

/** 측정 결과 JSON을 덮어쓴다. 쓴 경로를 돌려준다. */
export async function writeMeasure(name: string, data: unknown): Promise<string> {
  const p = measurePath(name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

const started = new Set<string>();
/** jsonl 한 줄. 이 프로세스에서 그 파일에 처음 쓰면 비우고 시작한다. */
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
