// 홈택스 예행(B1 "실화면 예행 10회 연속", 부장 2026-11-13): 첫 게이트에서 멈추는 실행의 보고서 한 줄.
// 엔진 로그 run.rehearsal_report에 단계별 시간, 폴백·판정 사용 수, 핸드오프 이유, 마지막 단계를 코드와 숫자로만 남긴다(값 없음).
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LogFields } from '@sax/platform';
import type { Page } from 'playwright-core';

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
/** 사람 차례가 나서 엔진이 바로 멈춘 예행의 끝 코드(예행 실패). 예행은 사람을 기다리지 않는다. */
export const REHEARSAL_HANDOFF = 'rehearsal.handoff';

export class RehearsalReport {
  private readonly t0: number;
  private readonly clock: () => number;
  /** 쓴 패키지 출처: registry:<판> · local:<판>:<manifest 다이제스트 앞 12자> · h01:<판>(가짜 포털 TS 플레이북). */
  private readonly pkg: string;
  private readonly phaseMs = new Map<string, number>();
  private open: { phase: string; at: number } | null = null;
  private last = '';
  private readonly counts = new Map<string, number>();
  private readonly handoffs: string[] = [];
  /** 닿은 게이트 스텝 id. 닿지 않았으면 null. */
  gateStep: string | null = null;
  /** handoff 순간 화면 기록을 시작했다(실행마다 한 번). */
  snapped = false;

  constructor(pkg: string, clock: () => number = Date.now) {
    this.pkg = pkg;
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

  get handedOff(): boolean {
    return this.handoffs.length > 0;
  }

  journal(type: string): void {
    const k = COUNTED[type];
    if (k) this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  fields(runId: string, end: { status: string; code?: string; stepId?: string }): LogFields {
    this.close(this.clock());
    const f: LogFields = {
      runId,
      result: this.gateStep ? 'gate_reached' : this.handedOff ? 'handoff' : end.status,
      package: this.pkg,
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

/** 화면 기록에 남기는 쿼리 키(메뉴·화면 위치만). 그 밖의 키는 값이 개인값일 수 있어 버린다. */
const SNAP_QUERY_KEYS = new Set(['w2xPath', 'tmIdx', 'tm2lIdx', 'tm3lIdx', 'menuCd', 'screenId']);

/**
 * 예행 handoff 순간의 화면 기록(부장 2026-11-14): <dir>/snap-<runId>.png(화면 한 장)과 .json(origin·경로·허용 쿼리·문서 제목·단계).
 * 앱 데이터 아래 로컬 파일에만 둔다(0600). 엔진 로그·게이트웨이로는 보내지 않는다. 금고가 캡처를 막으면(비밀 창 뒤) 화면 없이 .json만 남긴다.
 */
export async function rehearsalSnap(page: Page, dir: string, runId: string, at: { phase: string; code?: string }): Promise<void> {
  const u = new URL(page.url());
  const query = Object.fromEntries([...u.searchParams].filter(([k]) => SNAP_QUERY_KEYS.has(k)));
  const title = (await page.title().catch(() => '')).slice(0, 120);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let shot = false;
  try {
    await fs.writeFile(path.join(dir, `snap-${runId}.png`), await page.screenshot({ type: 'png', timeout: 4_000 }), { mode: 0o600 });
    shot = true;
  } catch {
    // 금고가 캡처를 거부했거나 시간이 지났다(.json의 shot false)
  }
  const meta = { runId, phase: at.phase, code: at.code ?? '', origin: u.origin, path: u.pathname, query, title, shot, at: new Date().toISOString() };
  await fs.writeFile(path.join(dir, `snap-${runId}.json`), JSON.stringify(meta, null, 1), { mode: 0o600 });
}
