// D08 §2 Noise 구현을 공개 시험 벡터(cacophony·snow)와 대조한다. XXpsk0 단독 벡터는 없어
// psk 위치 처리를 XXpsk3·XXpsk0+psk1·XXpsk0+psk2로, 패턴을 XX·IK로 확인한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CipherState, Handshake, fromHex, softNoiseStatic, toHex } from '@sax/remote';

interface Vec {
  protocol_name: string;
  source: string;
  init_prologue: string;
  resp_prologue: string;
  init_static?: string;
  resp_static?: string;
  init_ephemeral: string;
  resp_ephemeral: string;
  init_remote_static?: string;
  init_psks?: string[];
  resp_psks?: string[];
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

const vectors = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/remote-noise-vectors.json'), 'utf8')) as { vectors: Vec[] }).vectors;

function parse(name: string): { pattern: 'XX' | 'IK'; psks: number[] } {
  const m = /^Noise_(XX|IK)((?:psk\d\+?)*)_25519_ChaChaPoly_BLAKE2b$/.exec(name);
  assert.ok(m, name);
  const psks = m[2] ? m[2].split('+').map((x) => Number(x.replace('psk', ''))) : [];
  return { pattern: m[1] as 'XX' | 'IK', psks };
}

describe('Noise 시험 벡터', () => {
  for (const v of vectors) {
    it(`${v.source} ${v.protocol_name}`, async () => {
      const { pattern, psks } = parse(v.protocol_name);
      const init = new Handshake({
        pattern, psks, initiator: true, prologue: fromHex(v.init_prologue), ctx: 'SAX-session-v1',
        s: softNoiseStatic(fromHex(v.init_static!)), rs: v.init_remote_static ? fromHex(v.init_remote_static) : undefined,
        psk: (v.init_psks ?? []).map(fromHex), testEphemeral: fromHex(v.init_ephemeral),
      });
      const resp = new Handshake({
        pattern, psks, initiator: false, prologue: fromHex(v.resp_prologue), ctx: 'SAX-session-v1',
        s: softNoiseStatic(fromHex(v.resp_static!)), psk: (v.resp_psks ?? []).map(fromHex), testEphemeral: fromHex(v.resp_ephemeral),
      });
      let i = 0;
      while (!init.complete) {
        const [w, r] = init.myTurn ? [init, resp] : [resp, init];
        const m = v.messages[i++]!;
        const ct = await w.writeMessage(fromHex(m.payload));
        assert.equal(toHex(ct), m.ciphertext, `handshake msg ${i}`);
        assert.equal(toHex(await r.readMessage(ct)), m.payload);
      }
      assert.ok(resp.complete);
      if (v.handshake_hash) assert.equal(toHex(init.handshakeHash), v.handshake_hash);
      assert.equal(toHex(init.handshakeHash), toHex(resp.handshakeHash));
      const a = init.split();
      const b = resp.split();
      const ia = new CipherState(a.send), ib = new CipherState(b.recv), ra = new CipherState(b.send), rb = new CipherState(a.recv);
      // 핸드셰이크 뒤 메시지는 개시자→응답자, 응답자→개시자가 번갈아 온다(벡터 관례).
      let fromInit = pattern === 'XX' ? false : true; // XX 3메시지 뒤 첫 전송은 응답자, IK 2메시지 뒤는 개시자
      for (; i < v.messages.length; i++) {
        const m = v.messages[i]!;
        const [enc, dec] = fromInit ? [ia, ib] : [ra, rb];
        const ct = enc.encrypt(new Uint8Array(), fromHex(m.payload));
        assert.equal(toHex(ct), m.ciphertext, `transport msg ${i}`);
        assert.equal(toHex(dec.decrypt(new Uint8Array(), ct)), m.payload);
        fromInit = !fromInit;
      }
    });
  }
});
