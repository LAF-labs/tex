// 금고 키 연산을 Electron 런타임에서 돌려 본다(금고는 Electron utilityProcess에서 돈다. 다른 시험은 Node에서 돈다).
// 2026-11-17: 새 PC 연결이 "연결하는 중"에서 멈췄다. Electron(BoringSSL)의 node:crypto에는 'chacha20-poly1305'가 없어
// crypto.rkSeal이 "Unknown cipher"로 실패했는데, Node(OpenSSL)에서 도는 시험은 모두 통과했다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

/** 설치된 Electron 실행 파일. 내려받지 못한 환경(오프라인 설치)이면 null. */
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
      // CI는 Electron을 설치한다. 거기서 건너뛰면 이 시험이 지키는 것이 없다
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
    // Electron 45.1.0의 crypto.getCiphers()에는 chacha20-poly1305가 없다. ChaCha20-Poly1305는 @noble/ciphers로 한다(금고 crypto/ops.ts, @sax/remote).
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
