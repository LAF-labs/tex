// M5-1 레지스트리 회귀(D13 §1 "리모트·레지스트리 회귀", D09 §8, AUDIT-D D-02(N-10)). 엔진 트랙 고정 시드 샘플(tests/fixtures/registry)을 재사용해
// 변조·되감기 입력이 하나도 받아들여지지 않는지 본다(서명 2-of-3, keyEpoch, monotonic, 폐기 목록).
// 엔진 레지스트리 로더(#52, M1-4 뒷절반)·샘플이 없으면 건너뛴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as core from '@sax/engine/core';
import { FUZZ_ITER, FUZZ_SEED, rng } from './lib/fuzz.ts';

const DIR = path.resolve(import.meta.dirname, '../fixtures/registry');
type Decision = { ok: boolean; code?: string };
type Api = {
  acceptStatus: (next: unknown, ctx: object) => Decision & { accepted?: unknown };
  acceptRevoked: (next: unknown, ctx: object) => Decision & { accepted?: unknown };
  decodeSxp: (b: Buffer) => { ok: boolean };
  loadPackage: (raw: unknown, ctx: object) => Decision;
};
const api = core as unknown as Partial<Api>;
const samplesPath = path.resolve(import.meta.dirname, '../registry-samples.ts');
const ready = fs.existsSync(DIR) && typeof api.acceptStatus === 'function' && typeof api.acceptRevoked === 'function' && typeof api.decodeSxp === 'function' && typeof api.loadPackage === 'function' && fs.existsSync(samplesPath);
const skip = ready ? false : '엔진 레지스트리 로더·샘플(#52) main 머지 전';

describe('M5-1 레지스트리 회귀: 변조·되감기 거부', { skip }, () => {
  const file = (p: string) => fs.readFileSync(path.join(DIR, p));
  const doc = (p: string) => JSON.parse(file(p).toString('utf8')) as Record<string, unknown>;

  it('샘플 그대로는 받는다(기준점)', async () => {
    const { SAMPLE_NOW, sampleKeys } = (await import(pathToFileURL(samplesPath).href)) as { SAMPLE_NOW: number; sampleKeys: () => { roots: unknown } };
    const K = sampleKeys();
    const rev = api.acceptRevoked!(doc('registry/revoked_keys.json'), { roots: K.roots, current: null, now: SAMPLE_NOW });
    assert.ok(rev.ok, rev.code);
    const st = api.acceptStatus!(doc('registry/status.json'), { roots: K.roots, revoked: new Set(), current: null, now: SAMPLE_NOW });
    assert.ok(st.ok, st.code);
  });

  it(`status·폐기 목록의 서명 대상 칸을 한 글자 바꾸면 거부(${Math.min(FUZZ_ITER, 200)}회, 씨앗 ${FUZZ_SEED})`, async () => {
    const { SAMPLE_NOW, sampleKeys } = (await import(pathToFileURL(samplesPath).href)) as { SAMPLE_NOW: number; sampleKeys: () => { roots: unknown } };
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

  it(`.sxp 비트 하나를 뒤집으면 풀기·로드가 거부하거나, 받더라도 내용이 원본과 같다(${Math.min(FUZZ_ITER, 200)}회)`, async () => {
    const { SAMPLE_NOW, sampleKeys } = (await import(pathToFileURL(samplesPath).href)) as { SAMPLE_NOW: number; sampleKeys: () => { roots: unknown } };
    const { BUNDLE_ALLOWLIST } = (await import('@sax/model')) as { BUNDLE_ALLOWLIST: unknown };
    const { bundleOutcomes } = await import('../core-fixtures.ts');
    const K = sampleKeys();
    const ctx = { roots: K.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups: new Map(), storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: SAMPLE_NOW };
    type Sxp = { ok: true; sxp: { kind: string; raw: Record<string, Uint8Array> } } | { ok: false };
    const decode = api.decodeSxp as unknown as (b: Buffer) => Sxp;
    const load = api.loadPackage!;
    // 하위 조회 패키지가 없는 조회 패키지 둘로 본다(H-01은 조회 패키지 설치가 앞서야 한다).
    const names = ['hometax.invoice.lookup@1.0.0.sxp', 'hometax.invoice.email_status@1.0.0.sxp'];
    const r = rng(FUZZ_SEED + 3);
    let rejected = 0;
    for (const name of names) {
      const b = file(`packages/${name}`);
      const orig = decode(b);
      assert.ok(orig.ok && orig.sxp.kind === 'package', name);
      assert.ok(load(orig.sxp.raw, ctx).ok, `${name} 기준점 로드 실패`);
      for (let i = 0; i < Math.min(FUZZ_ITER, 200) / names.length; i++) {
        const x = Buffer.from(b);
        const k = Math.floor(r() * x.length);
        x[k] = x[k]! ^ (1 << Math.floor(r() * 8));
        const d = decode(x);
        if (!d.ok || d.sxp.kind !== 'package') {
          rejected++;
          continue;
        }
        const res = load(d.sxp.raw, ctx);
        if (!res.ok) {
          rejected++;
          continue;
        }
        // 받았다면 서명된 내용이 한 바이트도 달라지지 않았어야 한다(의미 없는 바이트만 바뀐 경우).
        for (const part of ['manifest', 'playbook', 'selectors', 'strings']) assert.ok(Buffer.from(d.sxp.raw[part]!).equals(Buffer.from(orig.sxp.raw[part]!)), `${name} @${k}: 내용이 바뀐 변조본을 로드했다(${part})`);
      }
    }
    assert.ok(rejected > 0, '변조본을 하나도 거부하지 않았다');
  });

  it('status 되감기: 긴급 status(monotonic 11)를 받은 뒤 이전 status(10)는 거부', async () => {
    const { SAMPLE_NOW, sampleKeys } = (await import(pathToFileURL(samplesPath).href)) as { SAMPLE_NOW: number; sampleKeys: () => { roots: unknown } };
    const K = sampleKeys();
    const ctx = (current: unknown) => ({ roots: K.roots, revoked: new Set(), current, now: SAMPLE_NOW });
    const st = api.acceptStatus!(doc('registry/status.json'), ctx(null));
    assert.ok(st.ok, st.code);
    const em = api.acceptStatus!(doc('registry/status-emergency.json'), ctx(st.accepted));
    assert.ok(em.ok, em.code);
    const back = api.acceptStatus!(doc('registry/status.json'), ctx(em.accepted));
    assert.equal(back.ok, false, '되감긴 status를 받았다');
  });

  it.todo('저장 버전보다 낮은 패키지 버전·keyEpoch 되감기, 폐기 키 서명을 정족수에서 빼는지(loadPackage storedVersion·revoked) — 서명된 낮은 버전 샘플이 생기면');
  it.todo('클라우드 services/registry 게시 관문과 같은 샘플로 상호 검증(#56, SIGNING.md §10.3)');
});
