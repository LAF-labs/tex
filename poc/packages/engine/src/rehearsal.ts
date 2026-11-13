// 홈택스 예행(B1 "실화면 예행 10회 연속", 부장 2026-11-13): 첫 게이트에서 멈추는 실행의 보고서 한 줄.
// 엔진 로그 run.rehearsal_report에 단계별 시간, 폴백·판정 사용 수, 핸드오프 이유, 마지막 단계를 코드와 숫자로만 남긴다(값 없음).
import type { LogFields } from '@sax/platform';

/** 저널 이벤트 → 보고서 칸. 표에 없는 이벤트는 세지 않는다. */
const COUNTED: Readonly<Record<string, string>> = {
  'fallback.refind': 'refind',
  'fallback.dropped': 'refind_dropped',
  'locate.asked': 'locate',
  'fallback.checkpoint': 'reentry',
  'judge.applied': 'judge',
  'judge.dialog': 'judge',
  'decide.result': 'decide',
  'agent.action': 'agent',
  'human.secret_fallback': 'secret_fallback',
};

/** 게이트에 닿아 엔진이 스스로 멈춘 예행의 끝 코드(셸은 이 코드로 "예행 마침" 문구를 보인다). */
export const REHEARSAL_DONE = 'rehearsal.gate_reached';

export class RehearsalReport {
  private readonly t0: number;
  private readonly clock: () => number;
  private readonly phaseMs = new Map<string, number>();
  private open: { phase: string; at: number } | null = null;
  private last = '';
  private readonly counts = new Map<string, number>();
  private readonly handoffs: string[] = [];
  /** 닿은 게이트 스텝 id. 닿지 않았으면 null. */
  gateStep: string | null = null;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.t0 = clock();
  }

  phase(phase: string, state: 'now' | 'done' | 'attention'): void {
    const now = this.clock();
    if (this.open && (this.open.phase !== phase || state !== 'now')) this.close(now);
    if (state === 'now' && !this.open) this.open = { phase, at: now };
    this.last = phase;
  }

  handoff(phase: string, code: string | undefined): void {
    this.handoffs.push(code ?? phase);
  }

  journal(type: string): void {
    const k = COUNTED[type];
    if (k) this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  fields(runId: string, end: { status: string; code?: string; stepId?: string }): LogFields {
    this.close(this.clock());
    const f: LogFields = {
      runId,
      result: this.gateStep ? 'gate_reached' : end.status,
      end: (end.code ?? '').slice(0, 80),
      total_ms: this.clock() - this.t0,
      last_phase: this.last,
      last_step: this.gateStep ?? end.stepId ?? '',
      handoffs: this.handoffs.length,
      handoff_codes: this.handoffs.join(':').slice(0, 80),
    };
    for (const [p, ms] of this.phaseMs) f[`${p}_ms`] = ms;
    for (const k of new Set(Object.values(COUNTED))) f[k] = this.counts.get(k) ?? 0;
    return f;
  }

  private close(now: number): void {
    if (!this.open) return;
    this.phaseMs.set(this.open.phase, (this.phaseMs.get(this.open.phase) ?? 0) + now - this.open.at);
    this.open = null;
  }
}
