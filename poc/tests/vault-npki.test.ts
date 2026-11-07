// 공동인증서(NPKI) 탐지(D05 §6 허용 동작, A-28): 열거, signCert.der 바이트만, signPri.key 열기·stat 0회(파일 접근 감사),
// 링크·하드링크·바꿔치기·크기·개수 상한, 로그에 경로·CA·이름 없음, control 포트 npki.list.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { VaultClient } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import {
  MemoryKeyStore, NPKI_CERT_MAX_BYTES, NPKI_LIMITS, nodeNpkiFs, npkiRoots, RPC_BY_PORT, scanNpki, Vault,
  type NpkiFs, type NpkiListResult, type NpkiRoot,
} from '@sax/vault';

const KEY_SENTINEL = 'TEST-NPKI-PRIVATE-KEY-DO-NOT-READ';
const der = (n = 1500) => {
  const b = randomBytes(n);
  b[0] = 0x30;
  return b;
};

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-npki-'));
}

/** <root>/<ca>/USER/<cn>/{signCert.der, signPri.key?} */
async function cert(root: string, ca: string, cn: string, o: { key?: boolean; bytes?: Buffer; user?: string; certName?: string } = {}) {
  const dir = path.join(root, ca, o.user ?? 'USER', cn);
  await fs.mkdir(dir, { recursive: true });
  const bytes = o.bytes ?? der();
  await fs.writeFile(path.join(dir, o.certName ?? 'signCert.der'), bytes);
  if (o.key !== false) await fs.writeFile(path.join(dir, 'signPri.key'), KEY_SENTINEL);
  return { dir, bytes };
}

/** 모든 파일 접근을 남기는 fs(감사). */
function auditFs(base: NpkiFs = nodeNpkiFs) {
  const calls: Array<{ op: 'lstat' | 'readdir' | 'open'; p: string }> = [];
  const fs: NpkiFs = {
    lstat: (p) => (calls.push({ op: 'lstat', p }), base.lstat(p)),
    readdir: (p) => (calls.push({ op: 'readdir', p }), base.readdir(p)),
    open: (p, f) => (calls.push({ op: 'open', p }), base.open(p, f)),
  };
  return { fs, calls };
}

function noKeyAccess(calls: Array<{ op: string; p: string }>) {
  const hits = calls.filter((c) => /signpri\.key$/i.test(c.p));
  assert.deepEqual(hits, [], 'signPri.key 열기·stat 0회(D13 §6)');
  for (const c of calls.filter((x) => x.op === 'open')) assert.match(path.basename(c.p), /^signcert\.der$/i, `signCert.der만 연다: ${c.p}`);
}

const roots = (dir: string, kind: NpkiRoot['kind'] = 'locallow'): NpkiRoot[] => [{ kind, dir }];

// Windows는 개발자 모드·관리자가 아니면 심볼릭 링크를 만들 수 없다(EPERM). 디렉터리 링크는 정션으로 만든다(재분석 지점이라 lstat·Dirent에서 링크로 보인다).
const dirLink = process.platform === 'win32' ? 'junction' : 'dir';

/** 파일 심볼릭 링크. Windows에서 권한이 없으면 false(정션은 파일에 못 쓴다). */
async function fileLink(target: string, p: string): Promise<boolean> {
  try {
    await fs.symlink(target, p, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

describe('NPKI 탐지 위치', () => {
  it('Windows LocalLow·Program Files, macOS Preferences·Documents·홈, 그 밖은 홈', () => {
    assert.deepEqual(npkiRoots('win32', { USERPROFILE: 'C:\\Users\\kim', ProgramFiles: 'D:\\PF' }, 'C:\\Users\\kim'), [
      { kind: 'locallow', dir: 'C:\\Users\\kim\\AppData\\LocalLow\\NPKI' },
      { kind: 'program_files', dir: 'D:\\PF\\NPKI' },
    ]);
    assert.deepEqual(npkiRoots('win32', {}, 'C:\\Users\\lee').map((r) => r.dir), ['C:\\Users\\lee\\AppData\\LocalLow\\NPKI', 'C:\\Program Files\\NPKI']);
    assert.deepEqual(npkiRoots('darwin', {}, '/Users/kim'), [
      { kind: 'preferences', dir: '/Users/kim/Library/Preferences/NPKI' },
      { kind: 'documents', dir: '/Users/kim/Documents/NPKI' },
      { kind: 'home', dir: '/Users/kim/NPKI' },
    ]);
    assert.deepEqual(npkiRoots('linux', {}, '/home/kim'), [{ kind: 'home', dir: '/home/kim/NPKI' }]);
    assert.deepEqual(npkiRoots('darwin', {}, ''), []);
  });
});

describe('NPKI 열거·읽기(D05 §6)', () => {
  it('CA·USER·cn 폴더를 돌며 signCert.der 바이트와 hasKey만 돌려준다, signPri.key는 열지도 stat하지도 않는다', async () => {
    const root = await tmpRoot();
    try {
      const a = await cert(root, 'yessign', 'cn=TEST홍길동()0001234567890,ou=RA센터,ou=XX은행,ou=개인,o=yessign,c=kr');
      const b = await cert(root, 'CrossCert', 'cn=TEST가나다컴퍼니()0009876543210', { key: false });
      const c = await cert(root, 'SignKorea', 'cn=TEST이름', { user: 'user', certName: 'SIGNCERT.DER' }); // 대소문자 섞임
      await fs.mkdir(path.join(root, 'KICA', 'USER', 'cn=빈폴더'), { recursive: true }); // 인증서 없음
      await fs.mkdir(path.join(root, 'TradeSign'), { recursive: true }); // USER 없음
      await fs.writeFile(path.join(root, 'stray.txt'), 'x');
      const audit = auditFs();
      const r = await scanNpki({ roots: roots(root), fs: audit.fs });
      assert.deepEqual(r.skipped, {});
      assert.deepEqual(r.certs.map((x) => x.ca), ['CrossCert', 'SignKorea', 'yessign']);
      const by = Object.fromEntries(r.certs.map((x) => [x.ca, x]));
      assert.deepEqual(Buffer.from(by.yessign!.certDer), a.bytes);
      assert.equal(by.yessign!.dir, a.dir);
      assert.equal(by.yessign!.certFile, 'signCert.der');
      assert.equal(by.yessign!.hasKey, true);
      assert.equal(by.yessign!.root, 'locallow');
      assert.deepEqual(Buffer.from(by.CrossCert!.certDer), b.bytes);
      assert.equal(by.CrossCert!.hasKey, false);
      assert.equal(by.SignKorea!.certFile, 'SIGNCERT.DER');
      assert.equal(by.SignKorea!.dir, c.dir);
      for (const x of r.certs) assert.match(x.id, /^[0-9a-f]{16}$/);
      assert.equal(new Set(r.certs.map((x) => x.id)).size, 3);
      noKeyAccess(audit.calls);
      assert.equal(audit.calls.filter((x) => x.op === 'open').length, 3);
      // 다시 불러도 id가 같다
      const again = await scanNpki({ roots: roots(root) });
      assert.deepEqual(again.certs.map((x) => x.id), r.certs.map((x) => x.id));
      // 결과 어디에도 개인키 내용이 없다
      assert.ok(!JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v)).includes(KEY_SENTINEL));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('없는 위치·파일인 위치·링크인 위치는 건너뛴다(오류 없음)', async () => {
    const base = await tmpRoot();
    try {
      const real = path.join(base, 'real');
      await cert(real, 'yessign', 'cn=TEST1');
      await fs.symlink(real, path.join(base, 'link'), dirLink);
      await fs.writeFile(path.join(base, 'file'), 'x');
      const r = await scanNpki({ roots: [{ kind: 'home', dir: path.join(base, 'none') }, { kind: 'home', dir: path.join(base, 'file') }, { kind: 'documents', dir: path.join(base, 'link') }] });
      assert.deepEqual(r, { certs: [], skipped: {} });
      const ok = await scanNpki({ roots: [{ kind: 'preferences', dir: real }] });
      assert.equal(ok.certs.length, 1);
      assert.equal(ok.certs[0]!.root, 'preferences');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('심볼릭 링크는 따라가지 않는다: signCert.der→signPri.key, cn·USER·CA 폴더 링크', async () => {
    const root = await tmpRoot();
    const outside = await tmpRoot();
    try {
      // signCert.der가 개인키를 가리키는 링크(낮은 무결성 프로세스가 심을 수 있다)
      const d1 = path.join(root, 'yessign', 'USER', 'cn=TEST링크');
      await fs.mkdir(d1, { recursive: true });
      await fs.writeFile(path.join(d1, 'signPri.key'), KEY_SENTINEL);
      // Windows 표준 사용자는 파일 링크를 만들 수 없다. 그때는 이 경우만 빠지고 폴더 링크 셋은 그대로 본다.
      const madeFileLink = await fileLink(path.join(d1, 'signPri.key'), path.join(d1, 'signCert.der'));
      // 밖을 가리키는 cn·USER·CA 링크
      const ext = await cert(outside, 'yessign', 'cn=TEST밖');
      await fs.symlink(ext.dir, path.join(root, 'yessign', 'USER', 'cn=TEST밖링크'), dirLink);
      await fs.mkdir(path.join(root, 'CrossCert'), { recursive: true });
      await fs.symlink(path.join(outside, 'yessign', 'USER'), path.join(root, 'CrossCert', 'USER'), dirLink);
      await fs.symlink(path.join(outside, 'yessign'), path.join(root, 'SignKorea'), dirLink);
      const audit = auditFs();
      const r = await scanNpki({ roots: roots(root), fs: audit.fs });
      assert.deepEqual(r.certs, []);
      assert.deepEqual(r.skipped, { symlink: madeFileLink ? 4 : 3 });
      assert.equal(audit.calls.filter((x) => x.op === 'open').length, 0, '아무것도 열지 않는다');
      assert.ok(!audit.calls.some((x) => x.p.startsWith(outside)), '밖으로 나가지 않는다');
      assert.ok(!audit.calls.some((x) => /signpri\.key$/i.test(x.p)));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('하드링크·특수 파일·0바이트·8KB 초과는 읽지 않는다', async () => {
    const root = await tmpRoot();
    try {
      const h = path.join(root, 'yessign', 'USER', 'cn=TEST하드링크');
      await fs.mkdir(h, { recursive: true });
      await fs.writeFile(path.join(h, 'signPri.key'), KEY_SENTINEL);
      await fs.link(path.join(h, 'signPri.key'), path.join(h, 'signCert.der'));
      await fs.mkdir(path.join(root, 'yessign', 'USER', 'cn=TEST폴더', 'signCert.der'), { recursive: true });
      await cert(root, 'yessign', 'cn=TEST빈', { bytes: Buffer.alloc(0) });
      await cert(root, 'yessign', 'cn=TEST큼', { bytes: der(NPKI_CERT_MAX_BYTES + 1) });
      const edge = await cert(root, 'yessign', 'cn=TEST경계', { bytes: der(NPKI_CERT_MAX_BYTES) });
      const audit = auditFs();
      const r = await scanNpki({ roots: roots(root), fs: audit.fs });
      assert.deepEqual(r.skipped, { linked: 1, not_file: 1, empty: 1, too_large: 1 });
      assert.equal(r.certs.length, 1);
      assert.deepEqual(Buffer.from(r.certs[0]!.certDer), edge.bytes, '8192B는 받는다');
      // 하드링크는 열었지만(signCert.der 이름) 내용을 돌려주지 않는다. 0바이트·초과는 열지도 않는다.
      assert.deepEqual(audit.calls.filter((x) => x.op === 'open').map((x) => path.basename(path.dirname(x.p))).sort(), ['cn=TEST경계', 'cn=TEST하드링크']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('열거와 열기 사이에 바뀐 파일(dev·ino 불일치)과 읽다 커진 파일은 버린다', async () => {
    const root = await tmpRoot();
    try {
      const a = await cert(root, 'yessign', 'cn=TEST바꿔치기');
      const other = path.join(root, 'other.der');
      await fs.writeFile(other, der());
      // open 시점에 다른 파일이 열리는 경우(rename 경쟁 모사)
      const swap: NpkiFs = { ...nodeNpkiFs, open: (p, f) => nodeNpkiFs.open(p.endsWith('signCert.der') ? other : p, f) };
      assert.deepEqual(await scanNpki({ roots: roots(root), fs: swap }), { certs: [], skipped: { changed: 1 } });
      // lstat 뒤 커진 파일
      const grow: NpkiFs = {
        ...nodeNpkiFs,
        open: async (p, f) => {
          if (p.endsWith('signCert.der')) await fs.appendFile(p, der(NPKI_CERT_MAX_BYTES));
          return nodeNpkiFs.open(p, f);
        },
      };
      assert.deepEqual(await scanNpki({ roots: roots(root), fs: grow }), { certs: [], skipped: { too_large: 1 } });
      void a;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('dev·ino는 bigint로 비교한다: 2^53 위에서 Number로는 같아 보이는 두 파일 ID, 파일 ID 0도 바뀐 것으로 본다(Windows NTFS 64비트 ID)', async () => {
    const root = await tmpRoot();
    try {
      await cert(root, 'yessign', 'cn=TEST큰ID');
      // 열거 때와 연 뒤의 파일 ID를 고정한다. 둘은 Number로 바꾸면 같은 값이 된다.
      const idAt = (ino: bigint): NpkiFs => ({
        ...nodeNpkiFs,
        lstat: async (p) => {
          const st = await nodeNpkiFs.lstat(p);
          return p.endsWith('signCert.der') ? Object.assign(st, { ino: 2n ** 60n + 2n }) : st;
        },
        open: async (p, f) => {
          const fh = await nodeNpkiFs.open(p, f);
          if (!p.endsWith('signCert.der')) return fh;
          const stat = fh.stat.bind(fh);
          return Object.assign(fh, { stat: async (o?: { bigint?: boolean }) => Object.assign(await stat(o as { bigint: true }), { ino }) }) as typeof fh;
        },
      });
      assert.equal(Number(2n ** 60n + 1n), Number(2n ** 60n + 2n), '시험 전제: Number로는 같다');
      assert.deepEqual(await scanNpki({ roots: roots(root), fs: idAt(2n ** 60n + 1n) }), { certs: [], skipped: { changed: 1 } });
      assert.deepEqual(await scanNpki({ roots: roots(root), fs: idAt(0n) }), { certs: [], skipped: { changed: 1 } });
      const same = await scanNpki({ roots: roots(root), fs: idAt(2n ** 60n + 2n) });
      assert.equal(same.certs.length, 1, '같은 ID면 받는다');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('개수 상한(CA·cn·전체)과 이상한 CA 이름', async () => {
    const root = await tmpRoot();
    try {
      for (let i = 0; i < NPKI_LIMITS.certsPerCa + 3; i++) await cert(root, 'yessign', `cn=TEST${String(i).padStart(3, '0')}`, { key: false, bytes: der(64) });
      await cert(root, '한글CA', 'cn=TEST이상한', { key: false });
      await cert(root, '.hidden', 'cn=TEST숨김', { key: false });
      const r = await scanNpki({ roots: roots(root) });
      assert.equal(r.certs.length, NPKI_LIMITS.certsPerCa);
      assert.equal(r.certs.at(-1)!.dir.endsWith(`cn=TEST${String(NPKI_LIMITS.certsPerCa - 1).padStart(3, '0')}`), true, '정렬 순서로 앞에서부터');
      assert.deepEqual(r.skipped, { bad_name: 2 });
      // 전체 상한: 위치 세 개에 64개씩
      const r3 = await scanNpki({ roots: [{ kind: 'home', dir: root }, { kind: 'documents', dir: root }, { kind: 'preferences', dir: root }] });
      assert.equal(r3.certs.length, NPKI_LIMITS.certsPerCa, '같은 폴더는 한 번만(id 중복 제거)');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('전체 상한 128을 넘으면 limit으로 센다', async () => {
    const base = await tmpRoot();
    try {
      const rs: NpkiRoot[] = [];
      for (let k = 0; k < 3; k++) {
        const dir = path.join(base, `r${k}`);
        rs.push({ kind: 'home', dir });
        for (let i = 0; i < 50; i++) await cert(dir, 'yessign', `cn=TEST${i}`, { key: false, bytes: der(32) });
      }
      const r = await scanNpki({ roots: rs });
      assert.equal(r.certs.length, NPKI_LIMITS.total);
      assert.ok((r.skipped.limit ?? 0) >= 1);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('읽지 못하는 폴더·파일은 unreadable로 건너뛴다', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const root = await tmpRoot();
    try {
      const a = await cert(root, 'yessign', 'cn=TEST잠김');
      const b = await cert(root, 'yessign', 'cn=TEST파일잠김');
      await fs.chmod(a.dir, 0o000);
      await fs.chmod(path.join(b.dir, 'signCert.der'), 0o000);
      const r = await scanNpki({ roots: roots(root) });
      assert.deepEqual(r, { certs: [], skipped: { unreadable: 2 } });
      await fs.chmod(a.dir, 0o755);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('npki.list(control 포트)', () => {
  it('control 포트에서만 부른다, 로그는 개수만(경로·CA·이름 없음)', async () => {
    const root = await tmpRoot();
    const appRoot = await tmpRoot();
    const log = new FileEventLog(null, 'vault');
    const audit = auditFs();
    const vault = new Vault({ paths: appPaths(appRoot), log, keyStore: new MemoryKeyStore(), npki: { roots: roots(root), fs: audit.fs } });
    const eng = new MessageChannel();
    const ctl = new MessageChannel();
    vault.attachPort('engine', wrapPort(eng.port1, 'node'));
    vault.attachPort('control', wrapPort(ctl.port1, 'node'));
    const engine = new VaultClient(wrapPort(eng.port2, 'node'));
    const control = new VaultClient(wrapPort(ctl.port2, 'node'));
    try {
      assert.ok(RPC_BY_PORT.control.includes('npki.list'));
      assert.ok(!RPC_BY_PORT.engine.includes('npki.list') && !RPC_BY_PORT.secretInput.includes('npki.list'));
      const a = await cert(root, 'yessign', 'cn=TEST김비밀()0001112223334');
      const r = await control.rpc<NpkiListResult>('npki.list', {});
      assert.equal(r.certs.length, 1);
      assert.ok(r.certs[0]!.certDer instanceof Uint8Array);
      assert.deepEqual(Buffer.from(r.certs[0]!.certDer), a.bytes);
      assert.equal(r.certs[0]!.hasKey, true);
      await assert.rejects(engine.rpc('npki.list', {}), /denied/);
      noKeyAccess(audit.calls);
      const lines = log.lines.join('\n');
      assert.match(lines, /"vault\.npki_listed"/);
      assert.match(lines, /"roots":1,"certs":1,"skipped":0/);
      for (const bad of ['yessign', 'TEST김비밀', '0001112223334', root, 'signCert', 'USER']) assert.ok(!lines.includes(bad), `로그에 ${bad} 없음`);
    } finally {
      await vault.shutdown();
      for (const c of [eng, ctl]) {
        c.port1.close();
        c.port2.close();
      }
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(appRoot, { recursive: true, force: true });
    }
  });

  it('기본 위치(이 PC)에서도 돌아간다: 결과 모양만 본다, signPri.key 접근 0회', async () => {
    const audit = auditFs();
    const r = await scanNpki({ fs: audit.fs });
    assert.ok(Array.isArray(r.certs));
    noKeyAccess(audit.calls);
  });
});
