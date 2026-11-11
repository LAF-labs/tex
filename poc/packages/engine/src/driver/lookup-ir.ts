// 조회 포트: 서명 조회 패키지(kind: lookup, manifest.lookupsUsed) IR을 팝업에서 돌린다(팀장 결정 2026-11-09 (가), D03 §5.6, D02 §4.4).
// 조회 화면으로 가는 길(goto·wait·fill·select·click)과 결과 표·열 이름·건수 문구가 모두 서명 패키지 안에 있다.
// 그래서 실기기에서 조회 셀렉터가 틀리면 앱 재배포 없이 조회 패키지를 다시 게시해 고친다(scripts/h01-republish.mjs).
//
// 조회는 읽기만 한다(V-22, 실행 시에도 다시 본다).
// - 실행 전에 lookupViolations를 다시 본다. 어기면 팝업을 열지 않고 lookup.package_invalid다(로더가 이미 거른다. 이중 방어).
// - 핸들러는 V-22가 허용하는 종류만 준다(goto·wait·assert·extract·select·fill·click·end). submit·gate·human·decide 등은 핸들러가 없다.
// - 동작은 팝업 탭의 GuardedActuator로만 한다. 무장(commitArmed)은 언제나 거짓이라 commits:true 항목을 누를 수 없다. 원래 탭은 건드리지 않는다.
//
// 부재 증거가 되려면 결과가 다 왔다는 것을 알아야 한다(PopupLookupPort의 data-count와 같은 뜻).
// - IR이 success로 끝나야 하고, 변수 count(건수 문구 extract)가 정수이며 읽은 행 수와 같아야 한다. 아니면 lookup.incomplete(조회 실패, 부재 아님).
// - match의 열과 승인번호 열은 strings `lookup.column.<열>`(머리글 문구)로 표 머리글에서 찾는다. 하나라도 없으면 lookup.columns_missing.
//   빈 표·덜 그린 표·열을 못 찾은 표가 "없음"으로 읽히면 기준선이 틀리거나 not_committed(재발급)로 갈 수 있기 때문이다.
// - 실패는 judgeVerify·takeBaseline이 받는다: 게이트 전 기준선 실패는 verify.baseline_missing(핸드오프, 발급 0), verify 중 실패는 부재 증거가 아니다.
// 값(행 문구)은 저널·로그에 남기지 않는다(⑦). 저널에는 코드와 스텝 id만.
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
/**
 * 카드 목록(머리글 행 없음, 홈택스 민원신청 처리결과): 행마다 이름·값 쌍이 있다. 둘 다 있으면 이 모양으로 읽는다.
 * 행 안의 이름 요소(labelCss)와 값 요소(valueCss)는 같은 수이고, 모든 행의 이름 차례가 같아야 한다(아니면 lookup.incomplete).
 * 머리글은 첫 행의 이름이다. 행이 0개면 열을 볼 수 없으니 건수 문구(count = 0)가 결과가 다 왔다는 근거다.
 */
const LABEL_CSS = 'lookup.table.labelCss';
const VALUE_CSS = 'lookup.table.valueCss';
const DEFAULT_ROW_CSS = 'tr, [role="row"]';
const DEFAULT_CELL_CSS = ':scope > th, :scope > td, :scope > [role="columnheader"], :scope > [role="rowheader"], :scope > [role="gridcell"], :scope > [role="cell"]';
/** 결과 표 extract 변수 이름과 건수 변수 이름(조회 IR 관례). */
export const LOOKUP_ROWS_VAR = 'rows';
export const LOOKUP_COUNT_VAR = 'count';

export interface IrLookupInput {
  /** 실행 탭(조회 팝업을 여는 곳). 이 탭에는 동작하지 않는다. */
  page: Page;
  /** verify.lookup.playbook → 서명 조회 패키지(로더를 지난 것). */
  packages: ReadonlyMap<string, LoadedPackage>;
  policy: LookupPolicy & ActionPolicy;
  events: ActuatorEvents;
  clock: Clock;
  fixtureGrant?: FixtureOriginGrant | null;
  /** 팝업 열기 대기 상한(기본 10초). */
  timeoutMs?: number;
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
        // 실기기 디버깅: 조회 패키지의 어느 스텝·셀렉터 키에서 멈췄는지(값 없음, ⑦). RunService가 엔진 로그 run.lookup_failed로도 남긴다.
        const at = [...flattenSteps(ir.steps)].find((x) => x.id === stop.at) as (Step & { target?: unknown; for?: unknown; value?: unknown }) | undefined;
        const target = typeof at?.target === 'string' ? at.target : at?.type === 'wait' && at.for === 'selector' && typeof at.value === 'string' ? at.value : '';
        this.i.events.journal('lookup.step_failed', { playbook: req.playbook, purpose: req.purpose, stepId: stop.at, stepType: at?.type ?? 'unknown', target, code: ('code' in stop && stop.code) || stop.t });
        return { ok: false, code: 'lookup.failed' };
      }

      // 결과 표: rows extract의 대상 항목. 표를 다시 해석해 머리글·행을 읽는다(읽기만).
      const rowsStep = [...flattenSteps(ir.steps)].find((x) => x.type === 'extract' && x.name === LOOKUP_ROWS_VAR) as (Step & { from: { a11y?: { target: string }; selector?: string } }) | undefined;
      const tableKey = rowsStep?.from.a11y?.target ?? rowsStep?.from.selector;
      if (!tableKey) return { ok: false, code: 'lookup.package_invalid' };
      const t = await resolveTarget(reader, files.selectors, tableKey);
      const handle = t.ok ? reader.handle(t.t.el) : null;
      if (!handle) return { ok: false, code: 'lookup.incomplete' };
      const labelled = !!(files.strings[LABEL_CSS] && files.strings[VALUE_CSS]);
      const table = await handle.evaluate(
        (el, css) => {
          const rows = [...(el as Element).querySelectorAll(css.row)];
          const cells = (r: Element) => [...r.querySelectorAll(css.cell)];
          const isHead = (c: Element) => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader';
          const text = (c: Element) => (c as HTMLElement).innerText ?? c.textContent ?? '';
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
            if (cs.every(isHead)) {
              header ??= cs.map(text);
              continue;
            }
            body.push(cs.map(text));
          }
          return { header, body, bad: false };
        },
        { row: files.strings[ROW_CSS] ?? DEFAULT_ROW_CSS, cell: files.strings[CELL_CSS] ?? DEFAULT_CELL_CSS, label: labelled ? files.strings[LABEL_CSS]! : '', value: labelled ? files.strings[VALUE_CSS]! : '' },
      );
      const count = Number(scope.vars.get(LOOKUP_COUNT_VAR)?.replace(/[^\d]/g, '') || NaN);
      if (table.bad || !Number.isSafeInteger(count) || count !== table.body.length) return { ok: false, code: 'lookup.incomplete' };
      // 카드 목록이 비었으면(건수 0과 같음) 열을 볼 수 없다. 머리글 표는 빈 표도 머리글이 있으니 아래 열 검사를 그대로 한다.
      if (labelled && table.body.length === 0) return halted() ?? { ok: true, rows: [] };
      // 열 이름 → 머리글 위치. 필요한 열(match·승인번호)이 하나라도 없으면 조회 실패다(그 열을 빈칸으로 읽으면 "없음"이 된다).
      const head = (table.header ?? []).map(norm);
      const col = new Map<string, number>();
      for (const [k, v] of Object.entries(files.strings)) {
        if (!k.startsWith(LOOKUP_COLUMN_PREFIX)) continue;
        const ix = head.indexOf(norm(v));
        if (ix >= 0) col.set(k.slice(LOOKUP_COLUMN_PREFIX.length), ix);
      }
      for (const need of [...Object.keys(req.match), VERIFY_ID_COLUMN]) if (!col.has(need)) return { ok: false, code: 'lookup.columns_missing' };
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
