// M5-1 IR·셀렉터·정책 퍼징(D13 §1 보안 스위트, D02 §6). 대상: @sax/engine/core validatePackage·schemaViolations.
// 골든 H-01 v2.1(제품 원본 packages/engine/playbooks)을 씨앗 고정으로 변이해 성질을 본다:
//   P1 예외·멈춤 없음(회차당 시간 상한), P2 결과는 위반 배열(규칙 번호·메시지 문자열), P3 같은 입력 → 같은 결과,
//   P4 위반 메시지에 사용자 문자열 사전 값이 실리지 않음("위반은 값 없음", validate.ts 머리말),
//   P5 게이트를 지운 패키지는 절대 통과하지 않음(비가역 스텝은 게이트 뒤에만, D02 V-03),
//   P6 프로토타입 오염 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCHEMA_NAMES, schemaViolations, validatePackage, type PackageFiles, type Violation } from '@sax/engine/core';
import { bundleOutcomes, h01, lookups } from '../core-fixtures.ts';
import { FUZZ_ITER, FUZZ_SEED, mutate, rng, type Json } from './lib/fuzz.ts';

const bundles = bundleOutcomes();
const opts = { bundles, lookups: lookups() };
const PER_CALL_MS = 2_000;
const PARTS = ['playbook', 'selectors', 'manifest'] as const;

function shapeOk(v: unknown): v is Violation[] {
  return Array.isArray(v) && v.every((x) => x && typeof x === 'object' && typeof (x as Violation).rule === 'string' && typeof (x as Violation).message === 'string');
}

function runOnce(p: PackageFiles): Violation[] {
  const t = performance.now();
  const v = validatePackage(p, opts);
  const ms = performance.now() - t;
  assert.ok(ms < PER_CALL_MS, `검증 ${ms.toFixed(0)}ms > ${PER_CALL_MS}ms`);
  return v;
}

describe('M5-1 퍼징: 플레이북 패키지(IR·셀렉터·manifest) → validatePackage', () => {
  it('골든은 위반 0(퍼징 기준점)', () => {
    assert.deepEqual(validatePackage(h01(), opts), []);
  });

  it(`변이 ${FUZZ_ITER}회: 예외·멈춤 없음, 위반 배열 모양, 결정적, 사용자 문자열 값 미노출 (씨앗 ${FUZZ_SEED})`, () => {
    const r = rng(FUZZ_SEED);
    const strVals = Object.values(h01().strings as Record<string, string>).filter((s) => typeof s === 'string' && s.length >= 6);
    let rejected = 0;
    for (let i = 0; i < FUZZ_ITER; i++) {
      const p = h01();
      const part = PARTS[Math.floor(r() * PARTS.length)]!;
      const steps: string[] = [];
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) steps.push(mutate(p[part] as unknown as Json, r));
      const tag = `회차 ${i}(씨앗 ${FUZZ_SEED}) ${part}: ${steps.join(' ; ')}`;
      let v: Violation[];
      try {
        v = runOnce(p);
      } catch (e) {
        assert.fail(`예외 ${tag}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
      }
      assert.ok(shapeOk(v), `모양 ${tag}`);
      assert.deepEqual(runOnce(structuredClone(p)), v, `비결정 ${tag}`);
      const msgs = v.map((x) => x.message).join('\n');
      for (const s of strVals) assert.ok(!msgs.includes(s), `사용자 문자열이 위반 메시지에 실림 ${tag}`);
      if (v.length) rejected++;
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined, '프로토타입 오염');
    // 변이 대부분은 거부돼야 한다(검증기가 무엇이든 통과시키는 퇴행 감지). 하한은 느슨하게.
    assert.ok(rejected > FUZZ_ITER * 0.5, `거부 ${rejected}/${FUZZ_ITER}`);
  });

  it('게이트(gate)를 지우거나 비가역 스텝 앞으로 옮기면 항상 거부(P5)', () => {
    const p = h01();
    p.playbook.steps = p.playbook.steps.filter((s) => s.type !== 'gate');
    assert.ok(validatePackage(p, opts).length > 0, '게이트 없는 H-01이 통과');
    const r = rng(FUZZ_SEED + 1);
    for (let i = 0; i < Math.min(FUZZ_ITER, 100); i++) {
      const q = h01();
      const steps = q.playbook.steps;
      const gi = steps.findIndex((s) => s.type === 'gate');
      const [g] = steps.splice(gi, 1);
      // 게이트를 아무 자리(제출 뒤 포함)에 다시 넣는다. 원래 자리면 건너뛴다.
      const at = Math.floor(r() * (steps.length + 1));
      if (at === gi) continue;
      steps.splice(at, 0, g!);
      const submitIdx = steps.findIndex((s) => s.type === 'submit');
      if (at > submitIdx) assert.ok(validatePackage(q, opts).length > 0, `게이트가 제출(${submitIdx}) 뒤(${at})인데 통과`);
    }
  });
});

describe('M5-1 퍼징: 스키마 7종 → schemaViolations', () => {
  const r = rng(FUZZ_SEED + 2);
  for (const name of SCHEMA_NAMES) {
    it(`${name}: 임의 JSON ${Math.min(FUZZ_ITER, 200)}회 예외 없음, 빈 문서·원시값은 거부`, () => {
      for (const junk of [null, 0, '', [], {}, 'x', true]) assert.ok(schemaViolations(name, junk).length > 0, `${name} ${JSON.stringify(junk)} 통과`);
      for (let i = 0; i < Math.min(FUZZ_ITER, 200); i++) {
        const doc: Json = { version: '2026.11', id: 'x', steps: [], entries: {} };
        for (let k = 0; k < 6; k++) mutate(doc, r);
        const v = schemaViolations(name, doc);
        assert.ok(shapeOk(v), `${name} 회차 ${i}`);
      }
    });
  }

  it('정책(policy): 골든 패키지의 manifest·selectors를 정책으로 넣으면 거부(문서 종류 혼동 방지)', () => {
    const p = h01();
    assert.ok(schemaViolations('policy', p.manifest).length > 0);
    assert.ok(schemaViolations('policy', p.selectors).length > 0);
    assert.ok(schemaViolations('hotfix', p.selectors).length > 0);
  });

  it.todo('정책 문서 골든 + 변이: 상한·하한(POLICY_FLOOR·PORTAL_MODE_CEILING) 집행은 정책 로더(M1-4 뒷절반·M2-4) 뒤 — 로더가 늘 내장 상한 안으로 접는지');
});
