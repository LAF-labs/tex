import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function electronBin(): Promise<string | null> {
  try {
    const p = (await import('electron')).default as unknown;
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('Electron 런타임의 금고 키 연산', () => {
  it('봉인·개봉, 새 PC 연결의 열쇠 넘기기, 큐 개봉, CODEF 비밀번호 봉인(RSA PKCS#1)이 Electron에서 돈다', async (t) => {
    const bin = await electronBin();
    if (!bin) {
      assert.ok(!process.env.CI, 'CI에 Electron 실행 파일이 없다');
      t.skip('Electron 실행 파일이 없다(오프라인 설치)');
      return;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_OPTIONS;
    const r = spawnSync(bin, ['--conditions=development', path.join(root, 'tests/vault-crypto-electron-child.ts')], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`.slice(-2_000));
    assert.match(r.stdout, /vault-crypto-electron ok \d+\./);
  });

  it('앱에 들어가는 코드는 node:crypto 암호 이름으로 aes-256-gcm만 쓴다(Electron에 없는 이름은 실행 때 Unknown cipher)', () => {
    const ALLOWED = new Set(["'aes-256-gcm'"]);
    const dirs = [...fs.readdirSync(path.join(root, 'packages')).map((n) => path.join(root, 'packages', n, 'src')), path.join(root, 'apps/desktop/src')].filter((d) => fs.existsSync(d));
    const bad: string[] = [];
    let seen = 0;
    for (const f of dirs.flatMap((d) => tsFiles(d))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bcreate(?:Cipher|Decipher)iv\(\s*([^,)]*)/g)) {
        seen++;
        if (!ALLOWED.has(m[1]!.trim())) bad.push(`${path.relative(root, f)}: ${m[0]}`);
      }
    }
    assert.ok(seen >= 4, '훑은 호출이 없다(경로가 바뀌었나)');
    assert.deepEqual(bad, []);
  });
});
