import type { Page, Response } from 'playwright-core';
import { GuardedActuator, type ActionPolicy, type ActuatorEvents } from '../core/actuator.ts';
import { Interpreter } from '../core/interp.ts';
import { navigationUrlProblem, type FixtureOriginGrant, type LoadedPackage } from '../core/loader.ts';
import type { Clock } from '../core/page.ts';
import { resolveTarget } from '../core/resolve.ts';
import { newScope } from '../core/scope.ts';
import { BASIC_HANDLERS, stepEnv, type Handlers } from '../core/steps.ts';
import type { GotoStep, Step } from '../core/types.ts';
import { hostAllowed, lookupViolations } from '../core/validate.ts';
import { VERIFY_ID_COLUMN, type LookupPort, type LookupRequest, type LookupResult, type LookupRow } from '../core/verify.ts';
import { PlaywrightActuator } from './actuator.ts';
import type { LookupPolicy } from './lookup.ts';
import { PlaywrightPageReader } from './reader.ts';

/** 조회 IR이 쓸 수 있는 스텝 종류(V-22 허용 목록과 같다). */
export const LOOKUP_STEP_TYPES = ['goto', 'wait', 'assert', 'extract', 'select', 'fill', 'click', 'end'] as const;

const LOOKUP_HANDLERS: Handlers = Object.fromEntries(LOOKUP_STEP_TYPES.map((t) => [t, BASIC_HANDLERS[t]]));

/** strings 키: 열 머리글 문구, 표 행·칸 CSS(없으면 표준 표·ARIA 격자). */
export const LOOKUP_COLUMN_PREFIX = 'lookup.column.';
const ROW_CSS = 'lookup.table.rowCss';
const CELL_CSS = 'lookup.table.cellCss';
const LABEL_CSS = 'lookup.table.labelCss';
const VALUE_CSS = 'lookup.table.valueCss';
const DEFAULT_ROW_CSS = 'tr, [role="row"]';
const DEFAULT_CELL_CSS = ':scope > th, :scope > td, :scope > [role="columnheader"], :scope > [role="rowheader"], :scope > [role="gridcell"], :scope > [role="cell"]';
const COL_ATTR = 'lookup.table.colAttr';
const CELL_ID = 'lookup.table.cellIdPattern';
const COMPLETE = 'lookup.table.complete';
const PAGE_SIZE = 'lookup.table.pageSize';

/** 결과가 다 왔는가: 건수 변수가 있으면 행 수와 같아야 하고, 없으면 'idle' 완결 규칙. 그 밖은 아니다(fail-closed). */
export function lookupComplete(steps: readonly Step[], strings: Readonly<Record<string, string>>, countVar: string | undefined, rows: number): boolean {
  if (countVar !== undefined) {
    const count = Number(countVar.replace(/[^\d]/g, '') || NaN);
    return Number.isSafeInteger(count) && count === rows;
  }
  if (strings[COMPLETE] !== 'idle') return false;
  const size = Number(strings[PAGE_SIZE]);
  if (!Number.isSafeInteger(size) || size < 1 || rows >= size) return false;
  const flat = [...flattenSteps(steps)];
  const ix = flat.findIndex((x) => x.type === 'extract' && x.name === LOOKUP_ROWS_VAR);
  const before = ix > 0 ? flat[ix - 1] : undefined;
  return before?.type === 'wait' && before.for === 'idle';
}

/** 결과 표 extract 변수 이름과 건수 변수 이름(조회 IR 관례). */
export const LOOKUP_ROWS_VAR = 'rows';
export const LOOKUP_COUNT_VAR = 'count';

export interface IrLookupInput {
  page: Page;
  packages: ReadonlyMap<string, LoadedPackage>;
  policy: LookupPolicy & ActionPolicy;
  events: ActuatorEvents;
  clock: Clock;
  fixtureGrant?: FixtureOriginGrant | null;
  timeoutMs?: number;
  onFail?: (popup: Page, at: { stepId: string; code: string }) => Promise<void>;
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

export class IrLookupPort implements LookupPort {
  private readonly i: IrLookupInput;

  constructor(i: IrLookupInput) {
    this.i = i;
  }

  async run(req: LookupRequest): Promise<LookupResult> {
    const pkg = this.i.packages.get(req.playbook);
    if (!pkg) return { ok: false, code: 'lookup.unknown_playbook' };
    const files = pkg.files;
    if (files.manifest.kind !== 'lookup' || lookupViolations(files).length) return { ok: false, code: 'lookup.package_invalid' };
    const ir = files.playbook;
    const first = ir.steps[0] as Step | undefined;
    if (first?.type !== 'goto' || !ir.steps[1]) return { ok: false, code: 'lookup.package_invalid' };
    const domains = files.manifest.domains;
    const url = (first as GotoStep).url;
    if (navigationUrlProblem(url, domains, this.i.fixtureGrant)) return { ok: false, code: 'lookup.package_invalid' };
    const a = await this.i.policy.beforeAction('navigate');
    if (!a.ok) return { ok: false, code: a.code };

    const timeout = this.i.timeoutMs ?? 10_000;
    const ctx = this.i.page.context();
    const onResponse = (r: Response) => {
      let portal = false;
      try {
        portal = hostAllowed(new URL(r.url()).hostname, domains);
      } catch {
        // 주소가 아니면 포털 응답이 아니다
      }
      if (!portal) return;
      let f: ReturnType<Response['frame']> | null;
      try {
        f = r.frame();
      } catch {
        f = null;
      }
      if (f?.page() === this.i.page) return;
      this.i.policy.observeStatus(r.status(), r.request().resourceType() === 'document' && (f === null || f.parentFrame() === null));
    };
    ctx.on('response', onResponse);
    let popup: Page;
    try {
      [popup] = await Promise.all([
        this.i.page.waitForEvent('popup', { timeout }),
        this.i.page.evaluate((u) => {
          window.open(u, '_blank');
        }, url),
      ]);
    } catch {
      ctx.off('response', onResponse);
      return { ok: false, code: 'lookup.popup_failed' };
    }
    const onNav = (f: ReturnType<Page['mainFrame']>) => {
      if (f === popup.mainFrame()) this.i.policy.observe({ url: f.url() });
    };
    popup.on('framenavigated', onNav);
    const reader = new PlaywrightPageReader(popup);
    const halted = (): LookupResult | null => (this.i.policy.halted ? { ok: false, code: this.i.policy.halted } : null);
    try {
      this.i.policy.observe({ url: popup.url() });
      await popup.waitForLoadState('domcontentloaded', { timeout });
      this.i.policy.observe({ text: await popup.locator('body').innerText({ timeout }).catch(() => '') });
      const s = await this.i.policy.settled();
      if (!s.ok) return { ok: false, code: s.code };
      const h0 = halted();
      if (h0) return h0;

      const act = new GuardedActuator({
        driver: new PlaywrightActuator({ page: popup, reader, afterNavigation: () => this.i.policy.settled() }),
        reader, dict: files.selectors, domains, policy: this.i.policy, events: this.i.events,
        commitArmed: () => false, armedConfirm: () => null, fixtureGrant: this.i.fixtureGrant ?? null,
      });
      const scope = newScope({ inputs: { ...req.match, window: req.window } });
      const env = stepEnv({ page: reader, act, clock: this.i.clock, dict: files.selectors, strings: files.strings, scope, domains, fixtureGrant: this.i.fixtureGrant ?? null, irreversible: new Set() });
      const interp = new Interpreter(ir, LOOKUP_HANDLERS, env, { retries: { stepMax: 1, backoff: 'equal_jitter', baseMs: 500, capMs: 2_000 }, retryFloorMs: 0, maxStepExecutions: 200 });
      const stop = await interp.run(ir.steps[1]!.id, first.id);
      const h1 = halted();
      if (h1) return h1;
      if (stop.t !== 'end' || stop.status !== 'success') {
        const at = [...flattenSteps(ir.steps)].find((x) => x.id === stop.at) as (Step & { target?: unknown; for?: unknown; value?: unknown }) | undefined;
        const target = typeof at?.target === 'string' ? at.target : at?.type === 'wait' && at.for === 'selector' && typeof at.value === 'string' ? at.value : '';
        const code = ('code' in stop && stop.code) || stop.t;
        this.i.events.journal('lookup.step_failed', { playbook: req.playbook, purpose: req.purpose, stepId: stop.at, stepType: at?.type ?? 'unknown', target, code });
        if (this.i.onFail) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([this.i.onFail(popup, { stepId: stop.at, code }).catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, 6_000)))]).finally(() => clearTimeout(timer));
        }
        return { ok: false, code: 'lookup.failed' };
      }

      const rowsStep = [...flattenSteps(ir.steps)].find((x) => x.type === 'extract' && x.name === LOOKUP_ROWS_VAR) as (Step & { from: { a11y?: { target: string }; selector?: string } }) | undefined;
      const tableKey = rowsStep?.from.a11y?.target ?? rowsStep?.from.selector;
      if (!tableKey) return { ok: false, code: 'lookup.package_invalid' };
      const t = await resolveTarget(reader, files.selectors, tableKey);
      const handle = t.ok ? reader.handle(t.t.el) : null;
      if (!handle) return { ok: false, code: 'lookup.incomplete' };
      const labelled = !!(files.strings[LABEL_CSS] && files.strings[VALUE_CSS]);
      const colAttr = files.strings[COL_ATTR];
      const cellId = files.strings[CELL_ID];
      if (cellId !== undefined) {
        let groups = 0;
        try {
          groups = (new RegExp(`${cellId}|`).exec('')?.length ?? 1) - 1;
        } catch {
          return { ok: false, code: 'lookup.package_invalid' };
        }
        if (groups < 2) return { ok: false, code: 'lookup.package_invalid' };
      }
      const byId = !!cellId;
      const table = await handle.evaluate(
        (el, css) => {
          const text = (c: Element) => (c as HTMLElement).innerText ?? c.textContent ?? '';
          if (css.cellId) {
            const re = new RegExp(css.cellId);
            const rows = new Map<string, Map<string, string>>();
            for (const c of (el as Element).querySelectorAll('[id]')) {
              const m = re.exec(c.id);
              if (!m || m[1] === undefined || m[2] === undefined) continue;
              let r = rows.get(m[1]);
              if (!r) rows.set(m[1], (r = new Map()));
              if (!r.has(m[2])) r.set(m[2], text(c));
            }
            const all = [...rows.values()];
            const header = all[0] ? [...all[0].keys()] : null;
            return { header, body: all.map((r) => (header ?? []).map((h) => r.get(h) ?? '')), bad: false };
          }
          const rows = [...(el as Element).querySelectorAll(css.row)];
          const cells = (r: Element) => [...r.querySelectorAll(css.cell)];
          const isHead = (c: Element) => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader';
          let header: string[] | null = null;
          const body: string[][] = [];
          if (css.label && css.value) {
            for (const r of rows) {
              const ls = [...r.querySelectorAll(css.label)].map(text);
              const vs = [...r.querySelectorAll(css.value)].map(text);
              if (!ls.length || ls.length !== vs.length) return { header, body, bad: true };
              header ??= ls;
              if (ls.join('\u0000') !== header.join('\u0000')) return { header, body, bad: true };
              body.push(vs);
            }
            return { header, body, bad: false };
          }
          for (const r of rows) {
            const cs = cells(r);
            if (!cs.length) continue;
            if (css.attr) {
              const named = cs.filter((c) => c.hasAttribute(css.attr!));
              if (!named.length || named.every(isHead)) continue;
              header ??= named.map((c) => c.getAttribute(css.attr!) ?? '');
              const byName = new Map(named.map((c) => [c.getAttribute(css.attr!) ?? '', text(c)]));
              body.push(header.map((h) => byName.get(h) ?? ''));
              continue;
            }
            if (cs.every(isHead)) {
              header ??= cs.map(text);
              continue;
            }
            body.push(cs.map(text));
          }
          return { header, body, bad: false };
        },
        {
          row: files.strings[ROW_CSS] ?? DEFAULT_ROW_CSS,
          cell: files.strings[CELL_CSS] ?? (colAttr ? `[${colAttr}]` : DEFAULT_CELL_CSS),
          attr: colAttr ?? null,
          label: labelled ? files.strings[LABEL_CSS]! : '',
          value: labelled ? files.strings[VALUE_CSS]! : '',
          cellId: cellId ?? '',
        },
      );
      const tableFail = (code: string) => {
        this.i.events.journal('lookup.table_failed', { playbook: req.playbook, purpose: req.purpose, code, rows: String(table.body.length), count: (scope.vars.get(LOOKUP_COUNT_VAR) ?? '').replace(/[^\d]/g, '').slice(0, 6), bad: String(table.bad), header: String((table.header ?? []).length) });
        return { ok: false as const, code };
      };
      if (table.bad || !lookupComplete(ir.steps, files.strings, scope.vars.get(LOOKUP_COUNT_VAR), table.body.length)) return tableFail('lookup.incomplete');
      if ((labelled || byId) && table.body.length === 0) return halted() ?? { ok: true, rows: [] };
      const head = (table.header ?? []).map(norm);
      const col = new Map<string, number>();
      for (const [k, v] of Object.entries(files.strings)) {
        if (!k.startsWith(LOOKUP_COLUMN_PREFIX)) continue;
        const ix = colAttr && !table.body.length ? 0 : head.indexOf(norm(v));
        if (ix >= 0) col.set(k.slice(LOOKUP_COLUMN_PREFIX.length), ix);
      }
      for (const need of [...Object.keys(req.match), VERIFY_ID_COLUMN]) if (!col.has(need)) return tableFail('lookup.columns_missing');
      const rows: LookupRow[] = table.body.map((cs) => Object.fromEntries([...col].map(([k, ix]) => [k, cs[ix] ?? ''])));
      const h2 = halted();
      if (h2) return h2;
      return { ok: true, rows };
    } catch {
      return { ok: false, code: this.i.policy.halted ?? 'lookup.failed' };
    } finally {
      popup.off('framenavigated', onNav);
      ctx.off('response', onResponse);
      await reader.release().catch(() => {});
      await popup.close().catch(() => {});
    }
  }
}

function* flattenSteps(steps: readonly Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    for (const v of Object.values(s as unknown as Record<string, unknown>)) if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'type' in x && 'id' in x)) yield* flattenSteps(v as Step[]);
  }
}
