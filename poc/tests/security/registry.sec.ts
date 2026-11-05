// M5-1 레지스트리 회귀(D13 §1 "리모트·레지스트리 회귀", D09 §8, AUDIT-D D-02(N-10)). 엔진 트랙 고정 시드 샘플(tests/fixtures/registry)을 재사용해
// 변조·되감기 입력이 하나도 받아들여지지 않는지 본다(서명 2-of-3, keyEpoch, monotonic, 폐기 목록).
// 엔진 레지스트리 로더(#52, M1-4 뒷절반)가 main에 들어오기 전에는 건너뛴다. 들어오면 그대로 돈다(이 파일은 고치지 않아도 된다).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as core from '@sax/engine/core';
import { FUZZ_ITER, FUZZ_SEED, rng } from './lib/fuzz.ts';

const DIR = path.resolve(import.meta.dirname, '../fixtures/registry');
type Decision = { ok: boolean; code?: string };
type Api = {
  acceptStatus: (next: unknown, ctx: object) => Decision & { accepted?: unknown };
  acceptRevoked: (next: unknown, ctx: object) => Decision & { accepted?: unknown };
  decodeSxp: (b: Buffer) => { ok: boolean };
};
const api = core as unknown as Partial<Api>;
const samplesPath = path.resolve(import.meta.dirname, '../registry-samples.ts');
const ready = fs.existsSync(DIR) && typeof api.acceptStatus === 'function' && typeof api.acceptRevoked === 'function' && typeof api.decodeSxp === 'function' && fs.existsSync(samplesPath);
const skip = ready ? false : '엔진 레지스트리 로더·샘플(#52) main 머지 전';

describe('M5-1 레지스트리 회귀: 변조·되감기 거부', { skip }, () => {
  const file = (p: string) => fs.readFileSync(path.join(DIR, p));
  const doc = (p: string) => JSON.parse(file(p).toString('utf8')) as Record<string, unknown>;

  it('샘플 그대로는 받는다(기준점)', async () => {
    const { SAMPLE_NOW, sampleKeys } = (await import(samplesPath)) as { SAMPLE_NOW: number; sampleKeys: () => { roots: unknown } };
    const K = sampleKeys();
    const rev = api.acceptRevoked!(doc('registry/revoked_keys.json'), { roots: K.roots, current: null, now: SAMPLE_NOW });
    assert.ok(rev.ok, rev.code);
    const st = api.acceptStatus!(doc('registry/status.json'), { roots: K.roots, revoked: new Set(), current: null, now: SAMPLE_NOW });
    assert.ok(st.ok, st.code);
  });

  it(`status·폐기 목록의 서명 대상 칸을 한 글자 바꾸면 거부(${Math.min(FUZZ_ITER, 200)}회, 씨앗 ${FUZZ_SEED})`, async () => {
    const { SAMPLE_NOW, sampleKeys } = (await import(samplesPath)) as { SAMPLE_NOW: number; sampleKeys: () => { roots: unknown } };
    const K = sampleKeys();
    const r = rng(FUZZ_SEED);
    const targets = [
      ['registry/status.json', (d: unknown) => api.acceptStatus!(d, { roots: K.roots, revoked: new Set(), current: null, now: SAMPLE_NOW })],
      ['registry/revoked_keys.json', (d: unknown) => api.acceptRevoked!(d, { roots: K.roots, current: null, now: SAMPLE_NOW })],
    ] as const;
    let tried = 0;
    for (const [p, accept] of targets) {
      const base = file(p).toString('utf8');
      const sigStart = base.indexOf('"signatures"');
      for (let i = 0; i < Math.min(FUZZ_ITER, 200); i++) {
        // 서명 칸 앞의 영숫자 하나를 바꾼다(JSON 모양은 유지). 서명 칸 자체 변조는 아래 시험.
        const pos = Math.floor(r() * (sigStart > 0 ? sigStart : base.length));
        const c = base[pos]!;
        if (!/[a-z0-9]/i.test(c)) continue;
        const repl = c === 'a' ? 'b' : c === '0' ? '1' : /[0-9]/.test(c) ? '0' : 'a';
        let d: unknown;
        try {
          d = JSON.parse(base.slice(0, pos) + repl + base.slice(pos + 1));
        } catch {
          continue;
        }
        tried++;
        const res = accept(d);
        assert.equal(res.ok, false, `${p} @${pos} '${c}'→'${repl}' 변조본을 받았다`);
      }
    }
    assert.ok(tried >= 50, `실제로 돌린 변조 ${tried}회(너무 적음)`);
  });

  it.todo('loadPackage: .sxp 바이트 변조는 registry.* 코드로 거부(decodeSxp는 저수준 디코더라 거부 증거가 아니다), 저장 버전보다 낮은 monotonic·keyEpoch 되감기 거부, 폐기 키 서명은 정족수에서 뺀다 — #52 API 확정 뒤');
  it.todo('클라우드 services/registry 게시 관문과 같은 샘플로 상호 검증(#56, SIGNING.md §10.3)');
});
