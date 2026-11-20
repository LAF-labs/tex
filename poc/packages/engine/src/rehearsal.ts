import fs from 'node:fs/promises';
import path from 'node:path';
import type { LogFields } from '@sax/platform';
import type { Page } from 'playwright-core';
import { estimateKrw } from './core/escalation.ts';

const COUNTED: Readonly<Record<string, string>> = {
  'fallback.refind': 'refind',
  'fallback.dropped': 'refind_dropped',
  'heal.seeded': 'heal',
  'fallback.heal_dropped': 'heal_dropped',
  'agentpath.replayed': 'replay',
  'agentpath.replay_failed': 'replay_failed',
  'locate.decision_asked': 'pick',
  'locate.asked': 'locate',
  'fallback.checkpoint': 'reentry',
  'judge.applied': 'judge',
  'judge.dialog': 'judge',
  'decide.result': 'decide',
  'agent.action': 'agent',
  'computer_use.action': 'vision',
  'human.secret_fallback': 'secret_fallback',
};

/** 게이트에 닿아 엔진이 스스로 멈춘 예행의 끝 코드(셸은 이 코드로 "예행 마침" 문구를 보인다). */
export const REHEARSAL_DONE = 'rehearsal.gate_reached';
/** 사람 차례가 나서 엔진이 바로 멈춘 예행의 끝 코드(예행 실패). 예행은 사람을 기다리지 않는다. */
export const REHEARSAL_HANDOFF = 'rehearsal.handoff';

export class RehearsalReport {
  private readonly t0: number;
  private readonly clock: () => number;
  private readonly pkg: string;
  private readonly phaseMs = new Map<string, number>();
  private open: { phase: string; at: number } | null = null;
  private last = '';
  private readonly counts = new Map<string, number>();
  private readonly handoffs: string[] = [];
  gateStep: string | null = null;
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
    f.est_krw = estimateKrw(Object.fromEntries(this.counts));
    return f;
  }

  private close(now: number): void {
    if (!this.open) return;
    this.phaseMs.set(this.open.phase, (this.phaseMs.get(this.open.phase) ?? 0) + now - this.open.at);
    this.open = null;
  }
}

const DOM_INVENTORY = (): unknown => {
  const vis = (e: Element) => {
    const r = (e as HTMLElement).getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  };
  const t = (s: string | null | undefined, n = 60) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const sel = 'a, button, input, select, textarea, label, th, h1, h2, h3, h4, legend, [role], .w2window, [id$="_title"], [class*="title"]';
  const out: unknown[] = [];
  for (const e of document.querySelectorAll(sel)) {
    if (out.length >= 600) break;
    const v = vis(e);
    const tag = e.tagName.toLowerCase();
    if (!v && tag !== 'select') continue;
    const x: Record<string, unknown> = { tag, id: e.id || undefined, cls: t(e.getAttribute('class'), 50) || undefined, role: e.getAttribute('role') || undefined, vis: v };
    const label = e.getAttribute('aria-label') || e.getAttribute('title');
    if (label) x.label = t(label);
    if (tag === 'input') {
      const i = e as HTMLInputElement;
      x.type = i.type;
      x.name = i.name || undefined;
      if (i.type === 'radio' || i.type === 'checkbox') {
        x.checked = i.checked;
        const l = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) : null;
        x.text = t(l?.textContent ?? i.parentElement?.textContent ?? '');
      }
      x.disabled = i.disabled || undefined;
      if (i.type === 'button' || i.type === 'submit') x.text = t(i.value, 40);
    } else if (tag === 'select') {
      const s = e as HTMLSelectElement;
      x.options = [...s.options].slice(0, 40).map((o) => t(o.textContent, 40));
      x.selected = t(s.selectedOptions[0]?.textContent, 40);
      x.disabled = s.disabled || undefined;
    } else if (tag !== 'textarea') {
      x.text = t((e as HTMLElement).innerText ?? e.textContent, tag === 'label' || tag === 'th' ? 40 : 80);
    }
    out.push(x);
  }
  const leaves: unknown[] = [];
  for (const e of document.querySelectorAll('[id]')) {
    if (leaves.length >= 400) break;
    if (e.matches(sel) || !vis(e)) continue;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join(' ');
    if (!t(own)) continue;
    leaves.push({ tag: e.tagName.toLowerCase(), id: e.id, cls: t(e.getAttribute('class'), 50) || undefined, role: e.getAttribute('role') || undefined, text: t(own, 60) });
  }
  return {
    leaves, url: location.pathname + location.search.replace(/([?&](?!w2xPath|tmIdx|tm2lIdx|tm3lIdx|menuCd)[^=&]+)=[^&]*/g, '$1=_'), items: out };
};

const SNAP_QUERY_KEYS = new Set(['w2xPath', 'tmIdx', 'tm2lIdx', 'tm3lIdx', 'menuCd', 'screenId']);

const DIALOGS = new WeakMap<Page, Array<{ kind: string; text: string; at: string }>>();

/**
 * 예행 화면 기록용으로 이 탭의 대화상자 글을 기억한다. 답하지 않는다(답은 엔진 wire의 대화상자 정책이 한다).
 * H-04 5차 예행(run-ac4e5602): 납세증명서를 누르자 alert가 떠 곧 닫혔는데 글이 어디에도 남지 않아 차단 이유를 알 수 없었다.
 */
export function watchDialogs(page: Page): void {
  if (DIALOGS.has(page)) return;
  const list: Array<{ kind: string; text: string; at: string }> = [];
  DIALOGS.set(page, list);
  page.on('dialog', (d) => {
    list.push({ kind: d.type(), text: d.message().replace(/\s+/g, ' ').trim().slice(0, 300), at: new Date().toISOString() });
    if (list.length > 5) list.shift();
  });
}

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
  const meta = { runId, phase: at.phase, code: at.code ?? '', origin: u.origin, path: u.pathname, query, title, shot, at: new Date().toISOString(), dialogs: DIALOGS.get(page) ?? [] };
  await fs.writeFile(path.join(dir, `snap-${runId}.json`), JSON.stringify(meta, null, 1), { mode: 0o600 });
  const dom = await page.evaluate(DOM_INVENTORY).catch(() => null);
  if (dom) await fs.writeFile(path.join(dir, `snap-${runId}.dom.json`), JSON.stringify(dom), { mode: 0o600 });
}
