// D08 메시지 종류마다: 유효 표본은 와이어(CBOR) 왕복, 무효 표본은 거부. 생성 검증기가 스키마 최신본과 같은지,
// 바이너리 필드가 CBOR 바이트열로 나가는지, 정규형 아닌 base64를 거부하는지 확인한다.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ALL_MESSAGE_TYPES, MESSAGE_TYPES, RECEIPT_CHUNK, b64, decodeCbor, decodeEnvelope, encodeCbor, encodeEnvelope, ulid, uuid4, validateEnvelope, type Envelope,
} from '@sax/remote';
import { k32 } from './remote-support.ts';

// ajv는 @sax/remote의 개발 의존이다(생성기와 같은 판본).
const require = createRequire(path.join(import.meta.dirname, '../packages/remote/package.json'));
const schemaPath = path.join(import.meta.dirname, '../../sovereign-ax/design/schemas/remote-envelope.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const PAIR = ulid();
const H = 'a'.repeat(64);
const sig64 = b64(new Uint8Array(64).fill(3));
const dl = {
  listVersion: 2,
  entries: [{ entry: { device_id: uuid4(), role: 'desktop', Sx: k32(), Vx: k32(), registered_at: 1, list_version: 2 }, aikSig: sig64 }],
  revoked: [{ device_id: uuid4(), revoked_at: 5, aikSig: sig64 }],
};

/** [type, from, body, 무효 변형] — 무효 변형은 스키마가 거부해야 한다. */
const SAMPLES: Record<string, { from: 'desktop' | 'mobile'; body: object; bad: object }> = {
  hello: { from: 'mobile', body: { appVersion: '1.0.0', protocol: 1, suites: ['noise-25519-chachapoly-blake2b'], deviceListVersion: 2, asyncSeqMax: 0, registryHeadHash: H, capabilities: ['receipt.v1'] }, bad: { appVersion: '1', protocol: 0, suites: [], deviceListVersion: 0, asyncSeqMax: 0, registryHeadHash: H, capabilities: [] } },
  'pair.ok': { from: 'desktop', body: { cert: b64(new Uint8Array(200)), aikPub: k32(), kvPub: k32(), kvSig: sig64, deviceList: dl, mbxId: k32(), tokRead: k32(), tokWrite: k32(), mbxEpoch: 0, acctClaim: b64(new Uint8Array(300)), desktopName: '사무실 PC' }, bad: { cert: 'x', aikPub: k32(), kvPub: k32(), kvSig: sig64, deviceList: dl, mbxId: k32(), tokRead: k32(), tokWrite: k32(), mbxEpoch: 0, kek: k32() } },
  'kek.grant': { from: 'desktop', body: { kek: k32(), kekVer: 1, kekRecord: { n: 1, salt: k32(), createdAt: 1, aikSig: sig64 } }, bad: { kek: k32(), kekVer: 0, kekRecord: { n: 1, salt: k32(), createdAt: 1, aikSig: sig64 } } },
  'devlist.push': { from: 'desktop', body: { deviceList: dl }, bad: { deviceList: { ...dl, entries: [{ entry: { ...dl.entries[0]!.entry, role: 'server' }, aikSig: sig64 }] } } },
  'mbx.reissue': { from: 'desktop', body: { mbxId: k32(), tokRead: k32(), tokWrite: k32(), mbxEpoch: 1 }, bad: { mbxId: k32(), tokRead: k32(), mbxEpoch: 1 } },
  'cmd.run': { from: 'mobile', body: { cmdId: ulid(), playbookId: 'hometax.issue_tax_invoice', inputs: {} }, bad: { cmdId: ulid(), playbookId: 'Bad Id', inputs: {} } },
  'cmd.abort': { from: 'mobile', body: { runId: ulid() }, bad: { runId: 'nope' } },
  'cmd.resume': { from: 'mobile', body: { runId: ulid() }, bad: {} },
  'run.event': { from: 'desktop', body: { runId: ulid(), event: 'run.started', at: 1 }, bad: { runId: ulid(), event: 'Run Started!', at: 1 } },
  'gate.request': {
    from: 'desktop',
    body: { runId: ulid(), stepId: 's3', reqId: ulid(), cardId: 'c1', gateKind: 'commit', effects: ['issue_document'], fields: [{ key: 'totalAmount', value: '550000' }], cardHashInputs: { readbackHash: H, packageDigest: H, authorizes: ['s4'], intentId: ulid() }, actionHash: H, requiredSigAlg: 'p256', challenge: k32(), exp: 1 },
    bad: { runId: ulid(), stepId: 's3', reqId: ulid(), cardId: 'c1', gateKind: 'commit', effects: ['issue_document'], fields: [], cardHashInputs: { readbackHash: H, packageDigest: H, authorizes: [], intentId: ulid() }, actionHash: H, requiredSigAlg: 'ed25519', challenge: k32(), exp: 1 },
  },
  'gate.response': { from: 'mobile', body: { runId: ulid(), stepId: 's3', reqId: ulid(), decision: 'approve', actionHash: H, sigAlg: 'p256', sig: sig64 }, bad: { runId: ulid(), stepId: 's3', reqId: ulid(), decision: 'maybe', actionHash: H, sigAlg: 'p256', sig: sig64 } },
  'consent.request': { from: 'desktop', body: { reqId: ulid(), scheduleId: 'sch1', playbookId: 'hometax.tax_cert', major: 1, effects: [], docType: 'tax_cert', profileRef: 'p1', mode: 'notify', challenge: k32(), exp: 1 }, bad: { reqId: ulid(), scheduleId: 'sch1', playbookId: 'hometax.tax_cert', major: 1, effects: [], docType: 'tax_cert', profileRef: 'p1', mode: 'yolo', challenge: k32(), exp: 1 } },
  'consent.response': { from: 'mobile', body: { reqId: ulid(), decision: 'consent', consentHash: H, sigAlg: 'ed25519', sig: sig64 }, bad: { reqId: ulid(), decision: 'approve', consentHash: H, sigAlg: 'ed25519', sig: sig64 } },
  'human.request': { from: 'desktop', body: { runId: ulid(), stepId: 's2', reqId: ulid(), kind: 'otp', prompt: '인증번호', ttl: 60 }, bad: { runId: ulid(), stepId: 's2', reqId: ulid(), kind: 'secret', prompt: '비밀번호', ttl: 60 } },
  'human.response': { from: 'mobile', body: { runId: ulid(), stepId: 's2', reqId: ulid(), value: '123456' }, bad: { runId: ulid(), stepId: 's2', reqId: ulid(), value: '1', sealed: b64(new Uint8Array(10)) } },
  'file.offer': { from: 'desktop', body: { docId: uuid4(), docType: 'tax_cert', bytes: 10, blobId: uuid4(), wDEK: b64(new Uint8Array(72)), kekVer: 1 }, bad: { docId: ulid(), docType: 'tax_cert', bytes: 10, blobId: uuid4(), wDEK: b64(new Uint8Array(72)), kekVer: 1 } },
  'query.documents': { from: 'mobile', body: { docType: 'tax_cert', limit: 10 }, bad: { limit: 1000 } },
  'query.result': { from: 'desktop', body: { items: [{ docId: uuid4(), docType: 'tax_cert' }] }, bad: { items: [{ docType: 'tax_cert' }] } },
  'rotate.static': { from: 'mobile', body: { oldStatic: k32(), newStatic: k32(), ts: 1, sig: sig64 }, bad: { oldStatic: k32(), newStatic: k32(), ts: -1, sig: sig64 } },
  close: { from: 'mobile', body: {}, bad: { reason: 'bye' } },
  ping: { from: 'mobile', body: {}, bad: { x: 1 } },
  pong: { from: 'desktop', body: {}, bad: { x: 1 } },
  'receipt.offer': {
    from: 'mobile',
    body: { msgId: ulid(), capturedAt: 1, mime: 'image/jpeg', bytes: 100_000, sha256: H, chunkSize: RECEIPT_CHUNK, chunkCount: 3, ocrEngine: 'ios_vision', ownerConfirmed: true, candidates: { amount: 12000, issuedOn: '2026-11-05', merchant: '율무커피', merchantBizNo: '123-45-67890' } },
    bad: { msgId: ulid(), capturedAt: 1, mime: 'image/png', bytes: 5_000_000, sha256: H, chunkSize: RECEIPT_CHUNK, chunkCount: 102, ocrEngine: 'cloud', ownerConfirmed: true },
  },
  'receipt.chunk': { from: 'mobile', body: { msgId: ulid(), index: 0, data: b64(new Uint8Array(RECEIPT_CHUNK)) }, bad: { msgId: ulid(), index: 128, data: b64(new Uint8Array(10)) } },
  'receipt.ack': { from: 'desktop', body: { msgId: ulid(), state: 'partial', missing: [1, 2] }, bad: { msgId: ulid(), state: 'stored', missing: [1] } },
  'cash.entry': { from: 'mobile', body: { msgId: ulid(), day: '2026-11-05', amount: 320000, enteredAt: 1 }, bad: { msgId: ulid(), day: '2026-13-01', amount: -5, enteredAt: 1 } },
  'cash.ack': { from: 'desktop', body: { msgId: ulid(), state: 'stored' }, bad: { msgId: ulid(), state: 'partial' } },
};

function env(type: string, from: 'desktop' | 'mobile', body: object): Envelope {
  return { v: 1, type, id: ulid(), pairId: PAIR, from, to: from === 'desktop' ? 'mobile' : 'desktop', seq: 0, ts: Date.now(), ttl: 300, body } as Envelope;
}

describe('스키마와 생성 검증기', () => {
  it('schema.gen.ts가 스키마 최신본에서 만든 것과 같다(스키마를 고치면 gen:schema)', async () => {
    const gen = await import('../packages/remote/scripts/gen-validator.mjs');
    const now = fs.readFileSync(path.join(import.meta.dirname, '../packages/remote/src/schema.gen.ts'), 'utf8');
    assert.equal(now, gen.generate(), 'pnpm --filter @sax/remote gen:schema');
  });
  it('메시지 종류 목록이 스키마 enum·표본과 같다', () => {
    assert.deepEqual([...MESSAGE_TYPES], schema.properties.type.enum);
    assert.deepEqual([...ALL_MESSAGE_TYPES].sort(), Object.keys(SAMPLES).sort());
  });
  it('생성 검증기와 Ajv 직접 컴파일이 표본마다 같은 판정', () => {
    const Ajv2020 = require('ajv/dist/2020').default;
    const v = new Ajv2020({ strict: false }).compile(schema);
    for (const [t, s] of Object.entries(SAMPLES)) {
      assert.equal(v(env(t, s.from, s.body)), true, `${t} valid`);
      assert.equal(v(env(t, s.from, s.bad)), false, `${t} bad`);
    }
  });
});

describe('메시지 종류마다 왕복·거부', () => {
  for (const [t, s] of Object.entries(SAMPLES)) {
    it(t, () => {
      const e = env(t, s.from, s.body);
      assert.ok(validateEnvelope(e), `${t} should validate`);
      const wire = encodeEnvelope(e);
      assert.deepEqual(decodeEnvelope(wire), e);
      assert.equal(validateEnvelope(env(t, s.from, s.bad)), false, `${t} bad should fail`);
      assert.throws(() => encodeEnvelope(env(t, s.from, s.bad)));
      // 방향이 정해진 종류는 반대 방향을 거부한다(Phase 1 새 종류)
      if (t.startsWith('receipt.') || t.startsWith('cash.')) assert.equal(validateEnvelope(env(t, s.from === 'mobile' ? 'desktop' : 'mobile', s.body)), false);
    });
  }
});

describe('와이어 형식', () => {
  it('바이너리 필드는 CBOR 바이트열, 문자열이면 거부', () => {
    const e = env('mbx.reissue', 'desktop', SAMPLES['mbx.reissue']!.body);
    const m = decodeCbor(encodeEnvelope(e)) as { body: Record<string, unknown> };
    assert.ok(m.body.mbxId instanceof Uint8Array && m.body.mbxId.length === 32);
    const forged = encodeCbor({ ...m, body: { ...m.body, mbxId: k32() } } as never);
    assert.equal(decodeEnvelope(forged), null);
  });
  it('바이너리 키가 아닌 곳의 바이트열은 거부', () => {
    const e = env('ping', 'mobile', {});
    const m = decodeCbor(encodeEnvelope(e)) as Record<string, unknown>;
    assert.equal(decodeEnvelope(encodeCbor({ ...m, id: new Uint8Array(26) } as never)), null);
  });
  it('정규형 아닌 base64·청크 크기·청크 수 불일치를 거부', () => {
    assert.equal(validateEnvelope(env('mbx.reissue', 'desktop', { ...SAMPLES['mbx.reissue']!.body, mbxId: k32().replace(/=$/, '') + '' })), false);
    assert.equal(validateEnvelope(env('receipt.chunk', 'mobile', { msgId: ulid(), index: 0, data: b64(new Uint8Array(RECEIPT_CHUNK + 1)) })), false);
    const o = SAMPLES['receipt.offer']!.body as Record<string, unknown>;
    assert.equal(validateEnvelope(env('receipt.offer', 'mobile', { ...o, chunkCount: 2 })), false);
  });
  it('from == to, 알 수 없는 type·추가 필드는 거부', () => {
    assert.equal(validateEnvelope({ ...env('ping', 'mobile', {}), to: 'mobile' }), false);
    assert.equal(validateEnvelope({ ...env('ping', 'mobile', {}), type: 'photo.upload' }), false);
    assert.equal(validateEnvelope({ ...env('ping', 'mobile', {}), extra: 1 }), false);
    assert.equal(validateEnvelope({ ...env('ping', 'mobile', {}), ttl: 86401 }), false);
  });
  it('최대 청크 봉투가 한 프레임에 들어간다', () => {
    const e = env('receipt.chunk', 'mobile', { msgId: ulid(), index: 85, data: b64(new Uint8Array(RECEIPT_CHUNK).fill(0xff)) });
    assert.ok(encodeEnvelope(e).length < 65_000);
  });
});
