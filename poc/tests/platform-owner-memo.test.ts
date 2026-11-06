// 폴더 소유자 확인 기억(ADR-039, WIN-REALDEVICE §6.1). 느린 Windows PC에서 PowerShell Get-Acl이 3.4~15초 걸려,
// 신뢰 소유자로 확인한 폴더는 같은 폴더(볼륨·파일 ID·생성 시각)인 동안 프로세스당 한 번만 읽는다. 시험은 읽기를 주입해 모든 OS에서 돈다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appPaths, dirIdentity, FileEventLog, OWNER_TIMEOUT_MS, OwnerMemo, TOOL_TIMEOUT_MS, type AclCheck, type DirGuard } from '@sax/platform';
import { MemoryKeyStore, Vault } from '@sax/vault';

const ME = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-owner-'));
}

describe('OwnerMemo(ADR-039)', () => {
  it('신뢰 소유자는 같은 폴더면 한 번만 읽고, 동시에 물어도 읽기 하나를 같이 기다린다', async () => {
    const dir = await tmpDir();
    try {
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const memo = new OwnerMemo(async () => {
        reads++;
        await gate;
        return ME;
      });
      const both = Promise.all([memo.isTrusted(dir, ME), memo.isTrusted(dir, ME)]);
      await new Promise((r) => setTimeout(r, 10));
      release();
      assert.deepEqual(await both, [true, true]);
      assert.equal(await memo.isTrusted(dir, ME), true);
      assert.equal(reads, 1);
      assert.equal(memo.size, 1);
      // 관리자·SYSTEM 소유도 신뢰 소유자다(isTrustedOwner)
      const admin = new OwnerMemo(async () => 'S-1-5-32-544');
      assert.equal(await admin.isTrusted(dir, ME), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('남의 소유는 기억하지 않는다: 매번 다시 읽고, 고쳐지면 그때부터 기억한다', async () => {
    const dir = await tmpDir();
    try {
      let owner = OTHER;
      let reads = 0;
      const memo = new OwnerMemo(async () => (reads++, owner));
      assert.equal(await memo.isTrusted(dir, ME), false);
      assert.equal(await memo.isTrusted(dir, ME), false);
      assert.equal(reads, 2);
      owner = ME;
      assert.equal(await memo.isTrusted(dir, ME), true);
      assert.equal(await memo.isTrusted(dir, ME), true);
      assert.equal(reads, 3);
      // 기억한 소유자라도 다른 사용자에게는 신뢰 소유자가 아니다
      assert.equal(await memo.isTrusted(dir, OTHER), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('같은 경로라도 지우고 다시 만들면 다른 폴더로 보고 다시 읽는다', async () => {
    const root = await tmpDir();
    const dir = path.join(root, 'profile');
    try {
      await fs.mkdir(dir);
      let reads = 0;
      const memo = new OwnerMemo(async () => (reads++, ME));
      const first = await dirIdentity(dir);
      assert.ok(first);
      assert.equal(await memo.isTrusted(dir, ME), true);
      await fs.rm(dir, { recursive: true });
      await new Promise((r) => setTimeout(r, 5));
      await fs.mkdir(dir);
      assert.notEqual(await dirIdentity(dir), first);
      assert.equal(await memo.isTrusted(dir, ME), true);
      assert.equal(reads, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('읽기 실패·읽는 동안 폴더가 바뀜·식별 없음(파일·링크·없음)이면 기억하지 않는다', async () => {
    const root = await tmpDir();
    try {
      const dir = path.join(root, 'd');
      await fs.mkdir(dir);
      let fail = true;
      let reads = 0;
      const memo = new OwnerMemo(async () => {
        reads++;
        if (fail) throw new Error('powershell timed out');
        return ME;
      });
      await assert.rejects(memo.isTrusted(dir, ME), /timed out/);
      fail = false;
      assert.equal(await memo.isTrusted(dir, ME), true);
      assert.equal(reads, 2, '실패는 기억하지 않는다');
      // 읽는 동안 다른 폴더가 됨
      let n = 0;
      const shifting = new OwnerMemo(async () => ME, async () => `id-${n++}`);
      assert.equal(await shifting.isTrusted(dir, ME), true);
      assert.equal(shifting.size, 0);
      // 식별 없음
      const file = path.join(root, 'f');
      await fs.writeFile(file, 'x');
      assert.equal(await dirIdentity(file), null);
      assert.equal(await dirIdentity(path.join(root, 'missing')), null);
      if (process.platform !== 'win32') {
        await fs.symlink(dir, path.join(root, 'link'));
        assert.equal(await dirIdentity(path.join(root, 'link')), null);
      }
      let nid = 0;
      const noId = new OwnerMemo(async () => (nid++, ME), async () => null);
      await noId.isTrusted(dir, ME);
      await noId.isTrusted(dir, ME);
      assert.equal(nid, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('소유자 읽기 상한은 다른 읽기 도구보다 길다(90초)', () => {
    assert.equal(OWNER_TIMEOUT_MS, 90_000);
    assert.ok(OWNER_TIMEOUT_MS > TOOL_TIMEOUT_MS);
  });
});

describe('금고 폴더 확인 미리 하기(ADR-039)', () => {
  it('warmDirChecks: 앱 루트·전용 프로필을 확인하고 걸린 시간만 남긴다(결과는 쓰지 않는다)', async () => {
    const root = await tmpDir();
    try {
      const paths = appPaths(root);
      const seen: string[] = [];
      const ok: AclCheck = { ok: true, problems: [] };
      const guard: DirGuard = {
        checkPrivate: async (d) => (seen.push(d), d === paths.chromeProfile ? { ok: false, problems: ['missing'] } : ok),
        ensurePrivate: async () => ok,
        excludeFromIndex: async () => {},
      };
      const log = new FileEventLog(null, 'vault');
      const vault = new Vault({ paths, log, keyStore: new MemoryKeyStore(), dirGuard: guard });
      await vault.warmDirChecks();
      assert.deepEqual(seen, [paths.root, paths.chromeProfile]);
      const line = log.lines.find((l) => l.includes('vault.dir_check_warm'));
      assert.ok(line);
      assert.match(line, /"ok":false/);
      // 도구 예외도 삼키고 남긴다
      const throwing = new Vault({ paths, log, keyStore: new MemoryKeyStore(), dirGuard: { ...guard, checkPrivate: async () => { throw new Error('boom'); } } });
      await throwing.warmDirChecks();
      assert.equal(log.lines.filter((l) => l.includes('vault.dir_check_warm')).length, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
