// 게이트 카드의 readback 칸(M2-3, D03 §3, D02 §8 s19b): readback이 세 값 일치로 고정한 $readback 값만 쓴다.
// 화면을 다시 읽지 않는다. 승인 카드·s19d(합계 산술)·s19f(입력 대조)가 같은 값을 본다.
import type { RunScope } from '../core/scope.ts';
import { READBACK_KEYS, type ReadbackKey } from '../gate.ts';

/** 13칸 중 하나라도 $readback에 없으면 null(실행 조율기는 게이트를 열지 않고 핸드오프한다). */
export function readbackCard(scope: Pick<RunScope, 'readback'>): Record<ReadbackKey, string> | null {
  const out = {} as Record<ReadbackKey, string>;
  for (const k of READBACK_KEYS) {
    const v = scope.readback.get(k);
    if (v === undefined) return null;
    out[k] = v;
  }
  return out;
}
