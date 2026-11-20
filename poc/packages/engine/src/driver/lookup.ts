import type { Page, Response } from 'playwright-core';
import type { ActResult } from '../core/page.ts';
import type { LookupPort, LookupRequest, LookupResult, LookupRow } from '../core/verify.ts';
import { hostAllowed } from '../core/validate.ts';
import type { LookupDef } from '../portal.ts';

/** 집행기에서 조회 포트가 쓰는 부분(RunEnforcer). */
export interface LookupPolicy {
  beforeAction(kind: 'navigate'): Promise<ActResult>;
  settled(): Promise<ActResult>;
  observe(where: { url?: string; text?: string }): void;
  observeStatus(status: number, document: boolean): void;
  readonly halted: string | null;
}

export interface PopupLookupInput {
  page: Page;
  origin: string;
  defs: ReadonlyMap<string, LookupDef>;
  policy: LookupPolicy;
  domains: readonly string[];
  timeoutMs?: number;
}

export class PopupLookupPort implements LookupPort {
  private readonly i: PopupLookupInput;

  constructor(i: PopupLookupInput) {
    this.i = i;
  }

  async run(req: LookupRequest): Promise<LookupResult> {
    const def = this.i.defs.get(req.playbook);
    if (!def) return { ok: false, code: 'lookup.unknown_playbook' };
    const url = new URL(def.path, this.i.origin);
    for (const [k, q] of Object.entries(def.query)) if (q) url.searchParams.set(q, req.match[k] ?? '');
    const a = await this.i.policy.beforeAction('navigate');
    if (!a.ok) return { ok: false, code: a.code };
    const timeout = this.i.timeoutMs ?? 10_000;
    const ctx = this.i.page.context();
    const onResponse = (r: Response) => {
      let portal = false;
      try {
        portal = hostAllowed(new URL(r.url()).hostname, this.i.domains);
      } catch {
        // 주소가 아니면 포털 응답이 아니다
      }
      const f = r.frame();
      if (!portal || f.page() === this.i.page) return;
      this.i.policy.observeStatus(r.status(), r.request().resourceType() === 'document' && f.parentFrame() === null);
    };
    ctx.on('response', onResponse);
    let popup: Page;
    try {
      [popup] = await Promise.all([
        this.i.page.waitForEvent('popup', { timeout }),
        this.i.page.evaluate((u) => {
          window.open(u, '_blank');
        }, url.toString()),
      ]);
    } catch {
      ctx.off('response', onResponse);
      return { ok: false, code: 'lookup.popup_failed' };
    }
    const onNav = (f: ReturnType<Page['mainFrame']>) => {
      if (f === popup.mainFrame()) this.i.policy.observe({ url: f.url() });
    };
    popup.on('framenavigated', onNav);
    try {
      this.i.policy.observe({ url: popup.url() });
      await popup.waitForLoadState('domcontentloaded', { timeout });
      this.i.policy.observe({ text: await popup.locator('body').innerText({ timeout }).catch(() => '') });
      const s = await this.i.policy.settled();
      if (!s.ok) return { ok: false, code: s.code };
      if (this.i.policy.halted) return { ok: false, code: this.i.policy.halted };
      const ready = popup.locator(def.ready);
      await ready.first().waitFor({ state: 'attached', timeout });
      if ((await ready.count()) !== 1) return { ok: false, code: 'lookup.ready_ambiguous' };
      const count = Number(await ready.getAttribute('data-count'));
      const rows: LookupRow[] = await popup
        .locator(def.rows)
        .evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((td) => [td.getAttribute('data-k') ?? '', td.textContent ?? '']))));
      if (!Number.isSafeInteger(count) || count !== rows.length) return { ok: false, code: 'lookup.incomplete' };
      if (this.i.policy.halted) return { ok: false, code: this.i.policy.halted };
      return { ok: true, rows };
    } catch {
      return { ok: false, code: this.i.policy.halted ?? 'lookup.failed' };
    } finally {
      popup.off('framenavigated', onNav);
      ctx.off('response', onResponse);
      await popup.close().catch(() => {});
    }
  }
}
