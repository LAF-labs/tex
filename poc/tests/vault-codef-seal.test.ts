// 계좌 자동조회(CODEF) 로그인 봉인(금고): 고른 인증서 하나의 der·key만 읽고, 금고 창 비밀번호를 CODEF 공개키로 감싼다. 평문 비밀번호는 엔진에 가지 않는다.
// 가짜 인증서 파일·임시 폴더·시험용 RSA 키쌍만 쓴다(실제 NPKI·키체인을 읽지 않는다).
import assert from 'node:assert/strict';
import { constants as cc, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { VaultClient } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import { MemoryKeyStore, nodeNpkiFs, RPC_BY_PORT, Vault, codefPublicKey, scanNpki, type CodefSealResult, type NpkiFs } from '@sax/vault';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PASSWORD = 'fake-cert-pw-1234!';

async function tree() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-codef-'));
  const mk = async (cn: string) => {
    const dir = path.join(root, 'yessign', 'USER', cn);
    await fs.mkdir(dir, { recursive: true });
    const der = randomBytes(1200);
    der[0] = 0x30;
    const key = randomBytes(1218);
    await fs.writeFile(path.join(dir, 'signCert.der'), der);
    await fs.writeFile(path.join(dir, 'signPri.key'), key);
    return { dir, der, key };
  };
  return { root, a: await mk('cn=TEST가()0001'), b: await mk('cn=TEST나()0002') };
}

function auditFs() {
  const opened: string[] = [];
  const f: NpkiFs = { lstat: nodeNpkiFs.lstat, readdir: nodeNpkiFs.readdir, open: (p, fl) => (opened.push(p), nodeNpkiFs.open(p, fl)) };
  return { fs: f, opened };
}

async function stack() {
  const t = await tree();
  const audit = auditFs();
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sax-codef-app-'));
  const vault = new Vault({ paths: appPaths(appRoot), log: new FileEventLog(null, 'vault'), keyStore: new MemoryKeyStore(), npki: { roots: [{ kind: 'preferences', dir: t.root }], fs: audit.fs }, secretTtlMs: 2_000 });
  const eng = new MessageChannel();
  const ctl = new MessageChannel();
  vault.attachPort('engine', wrapPort(eng.port1, 'node'));
  vault.attachPort('control', wrapPort(ctl.port1, 'node'));
  const engine = new VaultClient(wrapPort(eng.port2, 'node'));
  const control = new VaultClient(wrapPort(ctl.port2, 'node'));
  const needs: Array<Record<string, unknown>> = [];
  control.on('secret.needed', (d) => needs.push(d));
  const ids = (await scanNpki({ roots: [{ kind: 'preferences', dir: t.root }] })).certs;
  const idOf = (dir: string) => ids.find((c) => c.dir === dir)!.id;
  /** main이 하는 일: 비밀번호 창을 열고(금고 직결 포트) 사람이 넣은 값을 보낸다 */
  const windowProvide = async (bind: Record<string, unknown>, pw: string, remember = false) => {
    const ch = new MessageChannel();
    vault.attachPort('secretInput', wrapPort(ch.port1, 'node'), bind);
    const win = new VaultClient(wrapPort(ch.port2, 'node'));
    const r = win.rpc('secret.provide', { bytes: new TextEncoder().encode(pw), remember, scope: 'business' }).catch((e: Error) => e);
    const out = await Promise.race([r, new Promise((res) => setTimeout(() => res('no_reply'), 300))]);
    ch.port1.close();
    ch.port2.close();
    return out;
  };
  const close = () => (eng.port1.close(), eng.port2.close(), ctl.port1.close(), ctl.port2.close());
  return { t, audit, engine, control, needs, idOf, windowProvide, close };
}

const waitNeed = async (needs: unknown[], n: number) => {
  for (let i = 0; i < 100 && needs.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(needs.length, n);
};

describe('금고 codef.seal', () => {
  it('포트 허용: 엔진은 seal·cancel·forget, main은 windowClosed만', () => {
    for (const m of ['codef.seal', 'codef.cancel', 'codef.forget']) assert.ok(RPC_BY_PORT.engine.includes(m) && !RPC_BY_PORT.control.includes(m));
    assert.ok(RPC_BY_PORT.control.includes('codef.windowClosed'));
    assert.equal(codefPublicKey('not-a-key'), null);
    assert.ok(codefPublicKey(PUB_B64));
  });

  it('금고 창 비밀번호 → 고른 인증서 der·key + RSA로 감싼 비밀번호. 다른 인증서의 개인키는 열지 않는다', async () => {
    const s = await stack();
    try {
      const certId = s.idOf(s.t.a.dir);
      const p = s.engine.rpc<CodefSealResult>('codef.seal', { certId, publicKey: PUB_B64, scope: 'business', mode: 'ask' });
      await waitNeed(s.needs, 1);
      const need = s.needs[0]!;
      assert.equal(need.mode, 'codef');
      assert.match(String(need.reqId), /^[0-9a-f]{32}$/);
      // 다른 reqId로 창을 붙이면 받지 않는다(포트를 붙이지 않음)
      assert.equal(await s.windowProvide({ mode: 'codef', reqId: 'f'.repeat(32), scope: 'business' }, 'x'), 'no_reply');
      assert.deepEqual(await s.windowProvide({ mode: 'codef', reqId: need.reqId, scope: 'business' }, PASSWORD), {});
      const r = await p;
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.equal(r.remembered, false);
      assert.deepEqual(Buffer.from(r.derFile, 'base64'), s.t.a.der);
      assert.deepEqual(Buffer.from(r.keyFile, 'base64'), s.t.a.key);
      assert.equal(privateDecrypt({ key: privateKey, padding: cc.RSA_PKCS1_PADDING }, Buffer.from(r.password, 'base64')).toString('utf8'), PASSWORD);
      assert.ok(!JSON.stringify(r).includes(PASSWORD));
      const keyOpens = s.audit.opened.filter((x) => /signpri\.key$/i.test(x));
      assert.deepEqual(keyOpens, [path.join(s.t.a.dir, 'signPri.key')]);
      // 같은 창 포트로 두 번 보내도 받지 않는다(요청은 끝났다)
      assert.equal(await s.windowProvide({ mode: 'codef', reqId: need.reqId, scope: 'business' }, PASSWORD), 'no_reply');
    } finally {
      s.close();
    }
  });

  it('[이 PC에 기억]이면 다음 auto는 창 없이, forget 뒤에는 stored가 missing', async () => {
    const s = await stack();
    try {
      const certId = s.idOf(s.t.b.dir);
      // 금고가 열려 있어야 기억한다(main이 사용자 활동을 알린다)
      await s.control.rpc('session.idle', { idleSec: 0 });
      const p = s.engine.rpc<CodefSealResult>('codef.seal', { certId, publicKey: PUB_B64, scope: 'business', mode: 'auto' });
      await waitNeed(s.needs, 1);
      await s.windowProvide({ mode: 'codef', reqId: s.needs[0]!.reqId, scope: 'business' }, PASSWORD, true);
      assert.equal(((await p) as { remembered: boolean }).remembered, true);
      const again = await s.engine.rpc<CodefSealResult>('codef.seal', { certId, publicKey: PUB_B64, scope: 'business', mode: 'auto' });
      assert.equal(s.needs.length, 1, '창을 다시 열지 않는다');
      assert.ok(again.ok && privateDecrypt({ key: privateKey, padding: cc.RSA_PKCS1_PADDING }, Buffer.from(again.password, 'base64')).toString() === PASSWORD);
      assert.deepEqual(await s.engine.rpc('codef.forget', { certId, scope: 'business' }), { removed: true });
      assert.deepEqual(await s.engine.rpc('codef.seal', { certId, publicKey: PUB_B64, scope: 'business', mode: 'stored' }), { ok: false, reason: 'missing' });
    } finally {
      s.close();
    }
  });

  it('창이 닫히면 cancelled, 없는 인증서는 창 없이 not_found, 이상한 공개키는 bad_public_key', async () => {
    const s = await stack();
    try {
      const certId = s.idOf(s.t.a.dir);
      const p = s.engine.rpc<CodefSealResult>('codef.seal', { certId, publicKey: PUB_B64, scope: 'business', mode: 'ask' });
      await waitNeed(s.needs, 1);
      await s.control.rpc('codef.windowClosed', { reqId: s.needs[0]!.reqId });
      assert.deepEqual(await p, { ok: false, reason: 'cancelled' });
      assert.deepEqual(await s.engine.rpc('codef.seal', { certId: '0'.repeat(16), publicKey: PUB_B64, scope: 'business', mode: 'ask' }), { ok: false, reason: 'not_found' });
      assert.deepEqual(await s.engine.rpc('codef.seal', { certId, publicKey: 'AAAA', scope: 'business', mode: 'ask' }), { ok: false, reason: 'bad_public_key' });
      assert.equal(s.needs.length, 1);
      // 시간이 지나면 timeout
      const late = s.engine.rpc<CodefSealResult>('codef.seal', { certId, publicKey: PUB_B64, scope: 'business', mode: 'ask' });
      assert.deepEqual(await late, { ok: false, reason: 'timeout' });
    } finally {
      s.close();
    }
  });
});
