import { isDenyActionName } from './constants.ts';
import { decideDialog, type DialogKind } from './dialog.ts';
import type { ActResult, Actuator, ElementRef, PageReader, Resolved } from './page.ts';
import { nameMatches, resolveTarget } from './resolve.ts';
import { isSecretEntry, type PressStep, type SelectorDict, type SelectorEntry } from './types.ts';
import { navigationUrlProblem, type FixtureOriginGrant } from './loader.ts';

export type ActionKind = 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'secret_window';

/** 운영 정책 집행기(M2-4 정책 PR)가 구현한다. */
export interface ActionPolicy {
  beforeAction(kind: ActionKind): Promise<ActResult>;
  noteDialog(): void;
}

export interface ActuatorEvents {
  security(code: string, key: string): void;
  journal(type: string, payload: Record<string, string>): void;
}

/** 원시 대화상자(드라이버가 넘긴다). */
export interface DialogHandle {
  kind: DialogKind;
  message: string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
}

export interface GuardedActuatorInput {
  driver: Actuator;
  reader: PageReader;
  dict: SelectorDict;
  domains: readonly string[];
  policy: ActionPolicy;
  events: ActuatorEvents;
  commitArmed?: (key: string) => boolean;
  armedConfirm?: () => RegExp | null;
  fixtureGrant?: FixtureOriginGrant | null;
  dialogJudge?: (kind: DialogKind, notice: string) => Promise<'accept' | 'dismiss' | null>;
}

const DIALOG_JUDGE_MS = 25_000;

type Op = 'click' | 'fill' | 'clear' | 'select' | 'press' | 'secret_window';

const KIND: Record<Op, ActionKind> = { click: 'click', fill: 'fill', clear: 'fill', select: 'select', press: 'press', secret_window: 'secret_window' };

const SECURITY_CODES = new Set(['step.commit_shadow']);

const ACTIVATES = new Set<Op>(['click', 'press']);

export class GuardedActuator implements Actuator {
  private readonly driver: Actuator;
  private readonly reader: PageReader;
  private readonly dict: SelectorDict;
  private readonly domains: readonly string[];
  private readonly policy: ActionPolicy;
  private readonly events: ActuatorEvents;
  private readonly commitArmed: (key: string) => boolean;
  private readonly armedConfirm: () => RegExp | null;
  private readonly fixtureGrant: FixtureOriginGrant | null;
  private readonly dialogJudge: GuardedActuatorInput['dialogJudge'] | null;
  private lastNotice: string | null = null;
  private sinceAction: { kind: DialogKind; notice: string } | null = null;

  constructor(i: GuardedActuatorInput) {
    this.driver = i.driver;
    this.reader = i.reader;
    this.dict = i.dict;
    this.domains = i.domains;
    this.policy = i.policy;
    this.events = i.events;
    this.commitArmed = i.commitArmed ?? (() => false);
    this.armedConfirm = i.armedConfirm ?? (() => null);
    this.fixtureGrant = i.fixtureGrant ?? null;
    this.dialogJudge = i.dialogJudge ?? null;
  }

  get notice(): string | null {
    return this.lastNotice;
  }

  dialogSinceAction(): { kind: DialogKind; notice: string } | null {
    return this.sinceAction;
  }

  async goto(url: string): Promise<ActResult> {
    const p = await this.policy.beforeAction('navigate');
    if (!p.ok) return p;
    if (navigationUrlProblem(url, this.domains, this.fixtureGrant)) return { ok: false, code: 'step.url_not_allowed' };
    this.sinceAction = null;
    return this.driver.goto(url);
  }

  click(t: Resolved): Promise<ActResult> {
    return this.act('click', t, () => this.driver.click(t));
  }

  clickByBox(t: Resolved): Promise<ActResult> {
    const byBox = this.driver.clickByBox?.bind(this.driver);
    if (!byBox || this.dict.entries[t.key]?.commits) return Promise.resolve({ ok: false, code: 'step.timeout' });
    return this.act('click', t, () => byBox(t));
  }

  fill(t: Resolved, value: string, o: { keyEvents: boolean }): Promise<ActResult> {
    return this.act('fill', t, () => this.driver.fill(t, value, o));
  }

  clear(t: Resolved): Promise<ActResult> {
    return this.act('clear', t, () => this.driver.clear(t));
  }

  select(t: Resolved, option: string): Promise<ActResult> {
    return this.act('select', t, () => this.driver.select(t, option));
  }

  pickRow(t: Resolved, row: ElementRef): Promise<ActResult> {
    return this.act('click', t, async () => {
      const rows = this.dict.entries[t.key]?.rows;
      if (!rows) return { ok: false, code: 'step.selector_miss' };
      const now = await this.reader.query({ kind: 'css', value: rows.item }, this.dict.entries[t.key]!.frame, t.el);
      let here = false;
      for (const r of now) if (await this.reader.same(r, row)) here = true;
      if (!here) return this.refuse('step.identity_mismatch', t.key);
      return this.driver.click({ ...t, el: row });
    });
  }

  async press(key: PressStep['key'], t: Resolved | null): Promise<ActResult> {
    if (!t) {
      const p = await this.policy.beforeAction('press');
      if (!p.ok) return p;
      this.sinceAction = null;
      return this.driver.press(key, null);
    }
    return this.act('press', t, () => this.driver.press(key, t));
  }

  secretWindow(t: Resolved): Promise<ActResult> {
    return this.act('secret_window', t, async () => ({ ok: true }));
  }

  async dialog(d: DialogHandle): Promise<void> {
    this.policy.noteDialog();
    let decision;
    try {
      decision = decideDialog(d.kind, d.message, this.armedConfirm());
    } catch {
      decision = null;
    }
    if (!decision) {
      await d.dismiss().catch(() => {});
      this.events.journal('dialog.dismissed', { kind: d.kind });
      return;
    }
    if (decision.notice) this.lastNotice = decision.notice;
    this.sinceAction = { kind: d.kind, notice: decision.notice };
    if (decision.action === 'dismiss' && d.kind === 'confirm' && this.dialogJudge) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), DIALOG_JUDGE_MS)));
      const a = await Promise.race([this.dialogJudge(d.kind, decision.notice).catch(() => null), late]).finally(() => clearTimeout(timer));
      if (a === 'accept') {
        await d.accept().catch(() => {});
        this.events.journal('dialog.judge_accepted', { kind: d.kind });
        return;
      }
    }
    await (decision.action === 'accept' ? d.accept() : d.dismiss()).catch(() => {});
    this.events.journal(decision.event.type, decision.event.payload);
  }

  private async act(op: Op, t: Resolved, run: () => Promise<ActResult>): Promise<ActResult> {
    const p = await this.policy.beforeAction(KIND[op]);
    if (!p.ok) return p;
    const g = await this.guard(op, t);
    if (!g.ok) return g;
    this.sinceAction = null;
    return run();
  }

  private refuse(code: string, key: string): ActResult {
    if (SECURITY_CODES.has(code)) this.events.security(code, key);
    else this.events.journal('actuator.refused', { code, key });
    return { ok: false, code };
  }

  private async guard(op: Op, t: Resolved): Promise<ActResult> {
    const entry = this.dict.entries[t.key];
    if (!entry) return { ok: false, code: 'step.selector_miss' };
    const secret = isSecretEntry(entry);
    if (secret !== (op === 'secret_window')) return this.refuse('step.secret_field', t.key);
    if (entry.commits && !(op === 'click' && this.commitArmed(t.key))) return this.refuse('step.irreversible_unguarded', t.key);

    const r = await resolveTarget(this.reader, this.dict, t.key);
    if (!r.ok) return { ok: false, code: r.code };
    if (!(await this.reader.same(r.t.el, t.el))) return { ok: false, code: 'step.identity_mismatch' };
    if (entry.commits) return { ok: true };

    const commitsHere = Object.entries(this.dict.entries).filter(([, e]) => e.commits && e.landmark === entry.landmark);
    for (const [k] of commitsHere) {
      const c = await resolveTarget(this.reader, this.dict, k);
      if (!c.ok) {
        this.events.journal('actuator.commit_unresolved', { key: k, code: c.code });
        continue;
      }
      if (await this.reader.same(c.t.el, t.el)) return this.refuse('step.commit_shadow', t.key);
    }
    if (ACTIVATES.has(op) && this.shadowName(entry, commitsHere.map(([, e]) => e), (await this.reader.info(t.el)).name)) return this.refuse('step.commit_shadow', t.key);
    return { ok: true };
  }

  private shadowName(entry: SelectorEntry, commitsHere: SelectorEntry[], name: string): boolean {
    if (commitsHere.some((c) => nameMatches(c.namePattern, name))) return true;
    return !entry.reviewNote && isDenyActionName(name);
  }
}
