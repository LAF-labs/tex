// 스테이징 파일 한 번 읽기(@sax/platform readRegularFile): 경로를 두 번 따라가지 않고, 확인한 파일과 연 파일이 같은지 bigint dev·ino로 본다.
// 쓰는 곳: 금고 PDF 내려받기 마무리(pdf/save.ts), 엔진 PDF 저장(driver/pdf.ts). #199(NPKI)와 같은 결함 유형.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { nodeSafeReadFs, readRegularFile, type SafeReadFs } from '@sax/platform';

describe('readRegularFile(스테이징 파일 한 번 읽기)', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-safe-read-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const file = async (name: string, bytes: Uint8Array | string) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, bytes);
    return p;
  };

  it('일반 파일은 내용 그대로, 없음·0바이트·상한 초과는 이유와 함께 거부', async () => {
    const ok = await file('ok.pdf', 'abcdef');
    assert.deepEqual(await readRegularFile(ok, 6), { ok: true, bytes: new Uint8Array(Buffer.from('abcdef')) });
    assert.deepEqual(await readRegularFile(ok, 5), { ok: false, reason: 'too_large' });
    assert.deepEqual(await readRegularFile(path.join(dir, 'none.pdf'), 10), { ok: false, reason: 'missing' });
    assert.deepEqual(await readRegularFile(await file('empty.pdf', ''), 10), { ok: false, reason: 'empty' });
    assert.deepEqual(await readRegularFile(dir, 10), { ok: false, reason: 'not_file' });
  });

  it('하드링크(nlink>1)와 심볼릭 링크는 읽지 않는다', async () => {
    const a = await file('hl-a.pdf', 'x');
    await fs.link(a, path.join(dir, 'hl-b.pdf'));
    assert.deepEqual(await readRegularFile(a, 10), { ok: false, reason: 'linked' });
    const target = await file('target.pdf', 'secret-ish');
    const link = path.join(dir, 'sym.pdf');
    try {
      await fs.symlink(target, link);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return; // Windows: 개발자 모드·관리자가 아니면 링크를 못 만든다
      throw e;
    }
    assert.deepEqual(await readRegularFile(link, 100), { ok: false, reason: 'not_file' });
  });

  it('확인 뒤 바꿔치기(다른 파일이 열림)는 changed, 상한 넘게 커진 파일은 too_large, 상한 안에서 커지면 changed', async () => {
    const p = await file('swap.pdf', 'aaaa');
    const other = await file('other.pdf', 'bbbbbbbb');
    const swap: SafeReadFs = { ...nodeSafeReadFs, open: (q, f) => nodeSafeReadFs.open(q === p ? other : q, f) };
    assert.deepEqual(await readRegularFile(p, 100, { fs: swap }), { ok: false, reason: 'changed' });
    const growBig: SafeReadFs = { ...nodeSafeReadFs, open: async (q, f) => (await fs.appendFile(q, 'x'.repeat(200)), nodeSafeReadFs.open(q, f)) };
    assert.deepEqual(await readRegularFile(p, 100, { fs: growBig }), { ok: false, reason: 'too_large' });
    const q2 = await file('grow-small.pdf', 'aaaa');
    // 열고 fstat한 뒤에 커진다: 읽기가 fstat 크기보다 많이 나온다
    const growAfterOpen: SafeReadFs = {
      ...nodeSafeReadFs,
      open: async (q, f) => {
        const fh = await nodeSafeReadFs.open(q, f);
        const stat = fh.stat.bind(fh);
        return Object.assign(fh, { stat: async (o?: { bigint?: boolean }) => { const st = await stat(o as { bigint: true }); await fs.appendFile(q, 'zz'); return st; } }) as typeof fh;
      },
    };
    assert.deepEqual(await readRegularFile(q2, 100, { fs: growAfterOpen }), { ok: false, reason: 'changed' });
  });

  it('dev·ino는 bigint로 비교한다: 2^53 위에서 Number로는 같아 보이는 두 파일 ID, 파일 ID 0도 changed(Windows NTFS 64비트 ID)', async () => {
    const p = await file('bigid.pdf', 'pdf!');
    const idAt = (ino: bigint): SafeReadFs => ({
      lstat: async (q) => Object.assign(await nodeSafeReadFs.lstat(q), { ino: 2n ** 60n + 2n }),
      open: async (q, f) => {
        const fh = await nodeSafeReadFs.open(q, f);
        const stat = fh.stat.bind(fh);
        return Object.assign(fh, { stat: async (o?: { bigint?: boolean }) => Object.assign(await stat(o as { bigint: true }), { ino }) }) as typeof fh;
      },
    });
    assert.equal(Number(2n ** 60n + 1n), Number(2n ** 60n + 2n), '시험 전제: Number로는 같다');
    assert.deepEqual(await readRegularFile(p, 100, { fs: idAt(2n ** 60n + 1n) }), { ok: false, reason: 'changed' });
    assert.deepEqual(await readRegularFile(p, 100, { fs: idAt(0n) }), { ok: false, reason: 'changed' });
    const same = await readRegularFile(p, 100, { fs: idAt(2n ** 60n + 2n) });
    assert.equal(same.ok, true, '같은 ID면 읽는다');
  });
});
