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
