// 엔진 종료 때 원장 DB 닫기(D07 §1.3): SIGTERM(main의 utilityProcess.kill)·exit에서 한 번만 닫고, SIGTERM이면 0으로 나간다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openDatabase } from '@sax/db';
import { closeOnShutdown, type ShutdownProc } from '../packages/engine/src/shutdown.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-shutdown-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeProc(): ShutdownProc & EventEmitter & { codes: number[] } {
  const p = new EventEmitter() as ShutdownProc & EventEmitter & { codes: number[] };
  p.codes = [];
  p.exit = (code: number) => {
    p.codes.push(code);
    p.emit('exit');
  };
  return p;
}

describe('엔진 종료 때 원장 DB 닫기', () => {
  it('SIGTERM: DB를 닫고(WAL 체크포인트, -wal 지움) 0으로 나간다', () => {
    const file = path.join(dir, 'a.sqlite');
    const db = openDatabase(file, new Uint8Array(randomBytes(32)));
    db.prepare("INSERT INTO settings(key, value_json) VALUES ('t', '1')").run();
    assert.ok(fs.existsSync(`${file}-wal`), '열려 있는 동안 WAL이 있다');
    const proc = fakeProc();
    closeOnShutdown(() => db.close(), proc);
    proc.emit('SIGTERM');
    assert.equal(db.open, false);
    assert.deepEqual(proc.codes, [0]);
    assert.equal(fs.existsSync(`${file}-wal`), false, '닫으면 WAL이 정리된다');
  });

  it('exit만 와도 닫는다. 두 번 와도 close는 한 번', () => {
    let n = 0;
    const proc = fakeProc();
    closeOnShutdown(() => void n++, proc);
    proc.emit('exit');
    proc.emit('exit');
    proc.emit('SIGTERM');
    assert.equal(n, 1);
  });

  it('close가 던져도 SIGTERM이면 나간다', () => {
    const proc = fakeProc();
    closeOnShutdown(() => {
      throw new Error('busy');
    }, proc);
    proc.emit('SIGTERM');
    assert.deepEqual(proc.codes, [0]);
  });
});
