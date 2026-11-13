// 금고 IPC 계약(packages/vault/src/protocol.ts): 포트별 RPC 표, secretInput 결속(oneshot·store), R-C1 해시(D05 §3.3·§3.8, D03 §5.4).
// Chrome을 띄우지 않는다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  commitExpectedHash, normalizeCommitValue, parseSecretInputBind, RPC_BY_PORT, SECRET_KINDS, SECRET_ORIGINS, STORABLE_KINDS, VD_PURPOSES,
} from '@sax/vault';
import { startHarness, type Harness } from './harness.ts';

describe('금고 IPC 계약: 포트별 RPC', () => {
  it('비밀을 받는 메서드는 secretInput 포트에만 있다', () => {
    for (const m of ['secret.provide', 'secret.store']) {
      assert.ok(RPC_BY_PORT.secretInput.includes(m));
      assert.ok(!RPC_BY_PORT.engine.includes(m) && !RPC_BY_PORT.control.includes(m), `${m}는 engine·control에 없다`);
    }
    assert.deepEqual([...RPC_BY_PORT.secretInput].sort(), ['secret.provide', 'secret.store']);
  });

  it('세션 추종·저장 목록·삭제·Hello 열기는 control(main)에만, 타이피스트·커밋 가드는 engine에만, 키 연산은 control에만', () => {
    for (const m of ['session.event', 'session.idle', 'vault.unlock', 'vault.setStrict', 'secret.list', 'secret.has', 'secret.forget', 'run.begin', 'run.end', 'secretWindow.userDone']) {
      assert.ok(RPC_BY_PORT.control.includes(m), m);
      assert.ok(!RPC_BY_PORT.engine.includes(m), `${m}는 엔진이 부를 수 없다`);
    }
    for (const m of ['typist.fill', 'typist.authFailed', 'commitGuard.arm', 'commitGuard.disarm', 'getDbKeyOnce', 'browser.launch']) {
      assert.ok(RPC_BY_PORT.engine.includes(m), m);
      assert.ok(!RPC_BY_PORT.control.includes(m), `${m}는 main이 부르지 않는다`);
    }
    // 장기 키 연산: main(계정·기기·페어링, remote-ports.ts)만. 엔진 포트에는 없다: 엔진이 뚫려도 기기 키로 DPoP·계정 작업에 서명하지 못한다
    // (게이트웨이 헤더는 main이 만들어 준다, 팀장 결정 2026-11-06). 비밀 입력 포트에도 없다.
    for (const m of ['crypto.publicKeys', 'crypto.noiseDH', 'crypto.signVd', 'crypto.signAik', 'crypto.hpkeOpen']) {
      assert.ok(RPC_BY_PORT.control.includes(m), m);
      assert.ok(!RPC_BY_PORT.engine.includes(m), `${m}는 엔진이 부를 수 없다`);
      assert.ok(!RPC_BY_PORT.secretInput.includes(m), m);
    }
    // 계정 갱신 토큰: main만 읽고 쓴다(ADR-038 (f)). 엔진·비밀 입력 포트에는 없다.
    const ACCOUNT_REFRESH = ['account.refresh.read', 'account.refresh.write', 'account.refresh.forget'];
    for (const m of ACCOUNT_REFRESH) {
      assert.ok(RPC_BY_PORT.control.includes(m), m);
      assert.ok(!RPC_BY_PORT.engine.includes(m), `${m}는 엔진이 부를 수 없다`);
      assert.ok(!RPC_BY_PORT.secretInput.includes(m), m);
    }
    // 개인키·사이트 비밀을 꺼내는 메서드는 없다(D05 §5.1). 예외는 하나뿐이다: account.refresh.read는 계정 자격을 main(control)에게 준다.
    // 규칙 ②는 사이트 비밀에 대한 것이고 계정 자격은 main이 세션 토큰을 드는 것과 같은 등급이다(팀장 결정 2026-11-09, D05 §2). 위에서 control 전용임을 확인했다.
    for (const ms of Object.values(RPC_BY_PORT)) for (const m of ms) if (m !== 'account.refresh.read') assert.doesNotMatch(m, /private|export|getKey|reveal|read(Secret)?$/i);
  });

  it('비밀 종류 표: 인증서 비밀번호는 기억(저장 가능)하고 홈택스에만 넣는다, 모든 종류에 origin 목록이 있다', () => {
    // 대표 지시 2026-11-13(ADR-020 결정 2 갱신): 처음 넣은 인증서 비밀번호를 금고가 기억하고 다음부터 넣는다.
    assert.ok((STORABLE_KINDS as readonly string[]).includes('cert_password'));
    for (const k of SECRET_KINDS) assert.ok(Object.hasOwn(SECRET_ORIGINS, k), k);
    assert.deepEqual(SECRET_ORIGINS.cert_password, ['hometax.go.kr']);
    assert.equal(new Set(VD_PURPOSES).size, VD_PURPOSES.length);
  });
});

describe('secretInput 결속 검사', () => {
  it('oneshot: mode 없음·oneshot 허용, 필요한 필드만 복사', () => {
    assert.deepEqual(parseSecretInputBind({ runId: 'r1', kind: 'portal_password', scope: 'business', extra: 'x' }), { runId: 'r1', kind: 'portal_password', scope: 'business' });
    assert.deepEqual(parseSecretInputBind({ mode: 'oneshot', runId: 'r1', kind: 'security_card', scope: 'personal', row: 35 }), { runId: 'r1', kind: 'security_card', scope: 'personal', row: 35 });
  });

  it('oneshot: 잘못된 runId·kind·scope·row·mode는 거부', () => {
    const base = { runId: 'r1', kind: 'portal_password', scope: 'business' };
    for (const bad of [
      { ...base, runId: '../x' }, { ...base, runId: 'a'.repeat(65) }, { ...base, kind: 'toString' }, { ...base, kind: 'byok' },
      { ...base, scope: 'p1' }, { ...base, scope: '' }, { ...base, row: 0 }, { ...base, row: 36 }, { ...base, row: 1.5 },
      { ...base, mode: 'other' }, null, 'x', 1,
    ]) assert.equal(parseSecretInputBind(bad), null, JSON.stringify(bad));
  });

  it('store: 저장 가능 종류·고지 판이 있을 때만, runId·row는 받지 않는다', () => {
    assert.deepEqual(parseSecretInputBind({ mode: 'store', kind: 'security_card', scope: 'business', notice: { version: 't06-v1', extra: 1 } }), {
      mode: 'store', kind: 'security_card', scope: 'business', notice: { version: 't06-v1' },
    });
    const base = { mode: 'store', kind: 'portal_password', scope: 'business', notice: { version: 't06-v1' } };
    for (const bad of [
      { ...base, kind: 'cert_password' }, { ...base, notice: undefined }, { ...base, notice: { version: '' } }, { ...base, notice: { version: 'a b' } },
      { ...base, runId: 'r1' }, { ...base, row: 1 }, { ...base, scope: '../x' },
    ]) assert.equal(parseSecretInputBind(bad), null, JSON.stringify(bad));
  });
});

describe('secretInput 포트: 결속 모드가 메서드를 정한다', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  it('store 결속 포트에서 secret.provide는 거부한다', async () => {
    const bytes = new TextEncoder().encode('TEST-STORE-1234');
    const port = h.secretPort({ mode: 'store', kind: 'security_card', scope: 'business', notice: { version: 't06-v1' } });
    await assert.rejects(port.rpc('secret.provide', { bytes }), /denied/);
    assert.ok(h.log.lines.some((l) => l.includes('"vault.rpc_denied"') && l.includes('secret.provide')));
  });

  it('oneshot 결속 포트에서 secret.store는 거부한다', async () => {
    // 금고가 secret.needed를 보낸 결속만 붙는다(요청 기록을 직접 넣는다).
    (h.vault as unknown as { needs: Map<string, number> }).needs.set('r1|portal_password|business|', Date.now() + 60_000);
    const port = h.secretPort({ runId: 'r1', kind: 'portal_password', scope: 'business' });
    await assert.rejects(port.rpc('secret.store', { entries: [{ field: 'pw', bytes: new Uint8Array([1, 2, 3]) }] }), /denied/);
  });

  it('결속 없는·잘못된 store 결속 포트는 붙이지 않는다(vault.secret_input_unbound)', async () => {
    const before = h.log.lines.filter((l) => l.includes('vault.secret_input_unbound')).length;
    h.secretPort({ mode: 'store', kind: 'cert_password', scope: 'business', notice: { version: 'v1' } } as never);
    assert.equal(h.log.lines.filter((l) => l.includes('vault.secret_input_unbound')).length, before + 1);
  });

  it('엔진 포트는 control·secretInput 메서드를 부를 수 없다', async () => {
    for (const m of ['session.event', 'secret.forget', 'secret.list', 'vault.unlock', 'secret.store', 'secret.provide']) {
      await assert.rejects(h.client.rpc(m, {}), /denied/, m);
    }
    for (const m of ['getDbKeyOnce', 'commitGuard.arm', 'typist.fill']) await assert.rejects(h.control.rpc(m, {}), /denied/, m);
  });
});

describe('R-C1 해시(엔진·금고 공통)', () => {
  const map = { supplierBizNo: 'supBizNo', amount: 'splAmt', item: 'items[0].name' };

  it('키 순서와 무관하고, 공백·NFC 정규화를 거친다', () => {
    const a = commitExpectedHash({ supplierBizNo: '1234567890', amount: '1000000', item: '컨설팅 용역' }, map);
    const b = commitExpectedHash({ item: '  컨설팅   용역 ', amount: '1000000', supplierBizNo: '1234567890' }, { item: 'x', amount: 'y', supplierBizNo: 'z' });
    assert.equal(a, b);
    assert.equal(normalizeCommitValue('가'), '가', 'NFD 한글은 NFC로');
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('값 하나가 바뀌면 달라지고, 빠진 필드는 던진다', () => {
    const v = { supplierBizNo: '1234567890', amount: '1000000', item: '컨설팅 용역' };
    assert.notEqual(commitExpectedHash(v, map), commitExpectedHash({ ...v, amount: '1000001' }, map));
    assert.throws(() => commitExpectedHash({ supplierBizNo: '1', amount: '2' }, map), /missing field item/);
  });

  it('고정 벡터(엔진 트랙과 맞춤)', () => {
    assert.equal(commitExpectedHash({ a: '1', b: 'x y' }, { b: 'q', a: 'p' }), commitExpectedHash({ a: '1', b: 'x  y' }, { a: 'p', b: 'q' }));
    // sha256("SAX-rc1-v1\n" + '[["a","1"],["b","x y"]]')
    assert.equal(commitExpectedHash({ a: '1', b: 'x y' }, { a: 'p', b: 'q' }), '5809c1c07c3126a94a420001bb383563e4798bc09eb96db675fae994f044400a');
  });
});
