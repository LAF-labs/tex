// 게이트 카드의 readback 칸(M2-3, D03 §3, D02 §8 s19b): readback이 세 값 일치로 고정한 $readback 값만 쓴다.
// 화면을 다시 읽지 않는다. 승인 카드·s19d(합계 산술)·s19f(입력 대조)가 같은 값을 본다.
// 칸은 승인 카드 id별 앱 내장 표(gate.ts GATE_CARDS)다: invoice.confirm = H-01 13칸, cert.confirm = 민원증명 4칸.
import type { RunScope } from '../core/scope.ts';
import { GATE_CARDS } from '../gate.ts';

/** 카드 칸 중 하나라도 $readback에 없거나 표에 없는 카드면 null(실행 조율기는 게이트를 열지 않는다, gate.unavailable). */
export function readbackCard(scope: Pick<RunScope, 'readback'>, card = 'invoice.confirm'): Record<string, string> | null {
  const c = GATE_CARDS.get(card);
  if (!c) return null;
  const out: Record<string, string> = {};
  for (const k of c.keys) {
    const v = scope.readback.get(k);
    if (v === undefined) return null;
    out[k] = v;
  }
  return out;
}
