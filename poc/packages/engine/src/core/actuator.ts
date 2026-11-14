// GuardedActuator(D03 §5.2): 페이지를 바꾸는 모든 동작의 단일 통로. 원시 드라이버(Playwright 등)를 감싼다.
// 동작마다 순서: 정책(지연·카운터·쿨다운·상한, ActionPolicy) → 가드 → 드라이버.
// 가드(동작 직전마다, 스텝 핸들러가 이미 확인했어도 다시):
//   - 비밀 칸(V-20 런타임판): secretKind·password 항목은 secretWindow 말고는 어떤 동작도 받지 않는다.
//   - 커밋 항목(commits:true): 무장된(게이트 토큰 소비 + 원장 armed + 커밋 가드 무장) 그 항목의 click만. 나머지는 step.irreversible_unguarded.
//   - R-A1: 항목을 다시 해석해 같은 frame·landmark 안의 같은 요소이고, 역할·정규화 이름이 사전과 맞아야 한다. 아니면 step.identity_mismatch.
//   - R-A2(commits:false 항목): 같은 랜드마크의 모든 commits:true 항목을 해석해 같은 요소면 동작하지 않는다(step.commit_shadow, 보안).
//     해석에 실패한 커밋 항목은 비교에서 빼고 저널에만 남긴다.
//   - 커밋 그림자(click·press): 실제 이름이 같은 랜드마크 커밋 항목의 namePattern이나 DENY_ACTION_NAME에 맞으면 누르지 않는다(step.commit_shadow).
//     reviewNote로 검토된 항목은 DENY_ACTION_NAME 검사만 뺀다(SV-02).
// 저널·보안 이벤트에는 항목 키와 코드만 남긴다. 값·화면 문구는 남기지 않는다(⑦).
import { isDenyActionName } from './constants.ts';
import { decideDialog, type DialogKind } from './dialog.ts';
import type { ActResult, Actuator, ElementRef, PageReader, Resolved } from './page.ts';
import { nameMatches, resolveTarget } from './resolve.ts';
import { isSecretEntry, type PressStep, type SelectorDict, type SelectorEntry } from './types.ts';
import { navigationUrlProblem, type FixtureOriginGrant } from './loader.ts';

export type ActionKind = 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'secret_window';

/** 운영 정책 집행기(M2-4 정책 PR)가 구현한다. */
export interface ActionPolicy {
  /** 동작 직전: 스텝 지연·분당 네비게이션 자리·실행당 동작 수·벽시계·쿨다운·차단 신호 걸쇠. 거부면 {ok:false, code}. */
  beforeAction(kind: ActionKind): Promise<ActResult>;
  /** 거부할 수 없는 동작(대화상자 응답)을 센다. 대화상자는 상한에 닿아도 닫아야 한다. */
  noteDialog(): void;
}

export interface ActuatorEvents {
  /** 보안 이벤트(D16 §보안 이벤트 목록에 있는 코드만). key는 사전 항목 키. */
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
  /** manifest.domains(V-06 실행 시 재확인). */
  domains: readonly string[];
  policy: ActionPolicy;
  events: ActuatorEvents;
  /** 이 커밋 항목이 지금 무장돼 있는가(M2-3 submit이 R-G7 순서를 마친 뒤 참). 기본은 언제나 거짓. */
  commitArmed?: (key: string) => boolean;
  /** 무장된 커밋 구간에서 그 submit의 expectConfirm 패턴. 그 밖은 null. */
  armedConfirm?: () => RegExp | null;
  /** fixture 패키지 실행일 때만(loader.fixtureOriginGrant). 제품 dist에서는 발급되지 않고, 넘겨도 인정하지 않는다(ADR-039). */
  fixtureGrant?: FixtureOriginGrant | null;
  /**
   * 무장 밖 JS confirm을 정책이 dismiss로 정했을 때 묻는 판정(run/judge.ts onDialog, 첫 게이트 앞만). 'accept'면 수락한다(세션 연장 등).
   * 판정 쪽이 되돌릴 수 없는 문구는 늘 dismiss로 돌려준다. 늦으면(DIALOG_JUDGE_MS) 정책대로 dismiss.
   */
  dialogJudge?: (kind: DialogKind, notice: string) => Promise<'accept' | 'dismiss' | null>;
}

/** 대화상자가 떠 있는 동안 페이지가 멈추므로 판정은 짧게 기다린다. */
const DIALOG_JUDGE_MS = 25_000;

type Op = 'click' | 'fill' | 'clear' | 'select' | 'press' | 'secret_window';

const KIND: Record<Op, ActionKind> = { click: 'click', fill: 'fill', clear: 'fill', select: 'select', press: 'press', secret_window: 'secret_window' };

/** D16 보안 이벤트 목록에 있는 거부 코드. */
const SECURITY_CODES = new Set(['step.commit_shadow']);

/** 누름(활성화)이 되는 동작: 그림자 이름 검사 대상. */
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
  /** 마지막 동작을 시작한 뒤 뜬 대화상자(wait for:'dialog', IR rev v1.3.5). 동작을 시작할 때마다 비운다. 실행 메모리 전용. */
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

  /** 실행이 닫은 포털 대화상자의 마지막 문구(실행 메모리 전용, 카드의 '홈택스 안내'). */
  get notice(): string | null {
    return this.lastNotice;
  }

  /** 마지막 동작을 시작한 뒤 뜬(그리고 정책대로 닫은) 대화상자. 없으면 null. 문구는 NFKC·공백 접기 뒤 200자. */
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

  /** 되돌릴 수 있는 click의 두 번째 시도(Actuator.clickByBox). click과 같은 정책·가드(R-A1 동일성·R-A2·그림자)를 다시 지나고, commits 항목은 하지 않는다. */
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

  /**
   * 목록 행 누르기(IR rev v1.3.6 pick): 목록 항목 t를 click과 같은 가드(R-A1·R-A2·그림자)로 다시 확인하고,
   * row가 지금 그 목록의 행(rows.item)일 때만 그 행을 누른다. 목록 항목이 아니면 step.selector_miss.
   */
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

  /**
   * 금고 타이피스트의 비밀 창 개시 허가(D03 §5.2, A-26): 비밀 칸 항목에만, R-A1 재확인 뒤 1회. 글자 간격은 금고가 집행한다.
   * 허가만 하고 아무것도 입력하지 않는다(입력은 금고 프로세스 안에서).
   */
  secretWindow(t: Resolved): Promise<ActResult> {
    return this.act('secret_window', t, async () => ({ ok: true }));
  }

  /** 대화상자 응답(D03 §6). 상한·걸쇠와 무관하게 언제나 응답한다. */
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

  /** 거부를 남긴다. D16 §보안 이벤트 목록에 있는 것(step.commit_shadow)만 보안 이벤트, 나머지는 저널(목록 추가는 PROPOSED_D16). */
  private refuse(code: string, key: string): ActResult {
    if (SECURITY_CODES.has(code)) this.events.security(code, key);
    else this.events.journal('actuator.refused', { code, key });
    return { ok: false, code };
  }

  private async guard(op: Op, t: Resolved): Promise<ActResult> {
    // 사전의 항목을 쓴다(넘어온 t.entry를 믿지 않는다).
    const entry = this.dict.entries[t.key];
    if (!entry) return { ok: false, code: 'step.selector_miss' };
    const secret = isSecretEntry(entry);
    if (secret !== (op === 'secret_window')) return this.refuse('step.secret_field', t.key);
    if (entry.commits && !(op === 'click' && this.commitArmed(t.key))) return this.refuse('step.irreversible_unguarded', t.key);

    // R-A1: 다시 해석해 같은 요소인지(frame·landmark·역할·이름 모두 resolveTarget이 본다)
    const r = await resolveTarget(this.reader, this.dict, t.key);
    if (!r.ok) return { ok: false, code: r.code };
    if (!(await this.reader.same(r.t.el, t.el))) return { ok: false, code: 'step.identity_mismatch' };
    if (entry.commits) return { ok: true };

    // R-A2·커밋 그림자
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
