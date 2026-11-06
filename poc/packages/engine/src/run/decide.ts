// decide 스텝(M2-2 B, D02 §4 decide, D03 §5.3, D04 §3, D06 §2·§3): 화면 관측 → 마스킹 → L1 판정(L0 규칙 → 모델) → on[결과]로 분기.
// - 화면 관측(ScreenSource)은 scope('root' 또는 셀렉터 사전 키)의 접근성 트리다. 볼 수 없으면 portal.unobservable(핸드오프).
// - 모델 입력은 Redactor.applyTree(번들 maxInputBytes·needsAmounts, SCREEN_DATA 구분자)로만 만든다(③: 모델 송신은 redaction 경유).
//   마스킹이 실패하면(fail-closed) 모델을 부르지 않고 portal.unobservable.
// - L0 관측(ScreenObservation)은 같은 트리에서 값 없이 만든다. 모델로 보내지 않는다.
// - 예약 결과(엔진 처리, D02 V-07): blocked → portal.blocked(중단+쿨다운), logged_out_by_other_session → 핸드오프(자동 재로그인 없음, D03 §10).
// - 판정기 오류(게이트웨이 불가 등)는 decide.unavailable(핸드오프, D16).
// - 저널 decide.result에는 번들·결과·규칙 행·공급사·L0 여부·사전 필터 적중만 남긴다(⑦: 화면 텍스트 없음).
import type { DecideResult, RunToken } from '@sax/model';
import type { A11yNode, Redactor } from '@sax/redaction';
import type { ActResult } from '../core/page.ts';
import type { Handler, Outcome } from '../core/steps.ts';
import type { Judge } from '../l0/judge.ts';
import type { ObsNode, ScreenObservation } from '../l0/observation.ts';

export interface ScreenCapture {
  url: string;
  title: string;
  /** scope가 키면 그 요소 노드에 scopeId = 키가 붙어 있다. */
  tree: A11yNode;
}

export interface ScreenSource {
  /** 읽기 전용. scope 요소를 못 찾거나 화면을 읽을 수 없으면 null. */
  capture(scope: string): Promise<ScreenCapture | null>;
}

export interface BundleInfo {
  maxInputBytes: number;
  needsAmounts?: boolean;
  reservedOutcomes: readonly string[];
}

export interface DecideRecord {
  stepId: string;
  bundle: string;
  outcome: string;
  rule: number;
  provider: string;
  l0Only: boolean;
  injectionHit: boolean;
  reason?: string;
}

export interface DecideRunnerInput {
  screen: ScreenSource;
  redactor: Pick<Redactor, 'applyTree'>;
  judge: Pick<Judge, 'decide'>;
  runToken: RunToken;
  /** 앱 내장 번들 카탈로그(BV-06). */
  bundle: (wireId: string) => BundleInfo | null;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

/** 예약 결과의 엔진 처리(D02 V-07, D16 portal.*). FORCED_STOPS가 그 처리(중단·핸드오프)를 정한다. */
export const RESERVED_OUTCOME_CODES: Readonly<Record<string, string>> = {
  blocked: 'portal.blocked',
  logged_out_by_other_session: 'portal.logged_out_by_other_session',
};

/** 게이트 진입 전 사전 안전 판정(D03 §5.3 (a))에서 막는 직전 decide 결과. */
export const UNSAFE_BEFORE_GATE: ReadonlySet<string> = new Set(['blocked', 'security_warning', 'logged_out_by_other_session']);

const fail = (code: string): Outcome => ({ t: 'fail', code });

export class DecideRunner {
  private readonly i: DecideRunnerInput;
  private lastRec: DecideRecord | null = null;

  constructor(i: DecideRunnerInput) {
    this.i = i;
  }

  /** 직전 decide 결과(사전 안전 판정이 본다). */
  last(): DecideRecord | null {
    return this.lastRec;
  }

  /** 사전 안전 판정 (a): 직전 decide가 blocked·security_warning 쪽이면 게이트를 열지 않는다. */
  safeForGate(): ActResult {
    const r = this.lastRec;
    if (r && UNSAFE_BEFORE_GATE.has(r.outcome)) return { ok: false, code: r.outcome === 'logged_out_by_other_session' ? 'portal.logged_out_by_other_session' : 'portal.blocked' };
    return { ok: true };
  }

  readonly handler: Handler<'decide'> = async (s) => {
    const info = this.i.bundle(s.bundle);
    if (!info) return fail('decide.unavailable');
    const cap = await this.i.screen.capture(s.scope).catch(() => null);
    if (!cap) {
      this.i.journal('decide.unobservable', { stepId: s.id, bundle: s.bundle, cause: 'capture' });
      return fail('portal.unobservable');
    }
    let input;
    try {
      input = this.i.redactor.applyTree(cap.tree, {
        maxBytes: info.maxInputBytes,
        ...(s.scope === 'root' ? {} : { scopeId: s.scope }),
        ...(info.needsAmounts ? { needsAmounts: true } : {}),
        frame: 'screen',
      }).redacted;
    } catch (e) {
      this.i.journal('decide.unobservable', { stepId: s.id, bundle: s.bundle, cause: (e as { code?: string }).code ?? 'redaction' });
      return fail('portal.unobservable');
    }
    const obs = treeToObservation(cap.tree, cap.url, cap.title);
    let r: DecideResult & { injectionHit?: boolean };
    try {
      r = await this.i.judge.decide(s.bundle, obs, input, this.i.runToken);
    } catch {
      this.i.journal('decide.unavailable', { stepId: s.id, bundle: s.bundle });
      return fail('decide.unavailable');
    }
    const rec: DecideRecord = { stepId: s.id, bundle: s.bundle, outcome: r.outcome, rule: r.rule, provider: r.provider, l0Only: r.l0Only, injectionHit: !!r.injectionHit, ...(r.reason ? { reason: r.reason } : {}) };
    this.lastRec = rec;
    this.i.journal('decide.result', { ...rec });
    const reserved = RESERVED_OUTCOME_CODES[r.outcome];
    if (reserved && info.reservedOutcomes.includes(r.outcome)) return fail(reserved);
    const to = s.on[r.outcome] ?? s.on.unknown;
    return to ? { t: 'jump', to } : fail('decide.unknown');
  };
}

const DIALOG_ROLES = new Set(['dialog', 'alertdialog', 'alert']);

/** 트리 → L0 관측(값 없음, 비밀 칸 이름도 없음). 대화상자 아래 노드는 inDialog. scope 노드가 있으면 그 서브트리만. */
export function treeToObservation(root: A11yNode, url: string, title: string): ScreenObservation {
  const nodes: ObsNode[] = [];
  const walk = (n: A11yNode, inDialog: boolean, top: boolean) => {
    if (n.hidden) return;
    if (!top || n.name) nodes.push({ role: n.role, name: n.secret ? '' : (n.name ?? ''), ...(n.states?.length ? { states: [...n.states] } : {}), ...(inDialog ? { inDialog: true } : {}) });
    const here = inDialog || DIALOG_ROLES.has(n.role);
    for (const c of n.children ?? []) walk(c, here, false);
  };
  walk(root, false, true);
  return { kind: 'screen', url, title, nodes };
}

/** DefaultModelLayer·BundleCatalog에서 번들 정보를 읽는 어댑터. */
export function bundleInfoFrom(catalog: { get(wireId: string): { def: { maxInputBytes: number; needsAmounts?: boolean; reservedOutcomes: string[] } } | undefined }): (wireId: string) => BundleInfo | null {
  return (wireId) => {
    const b = catalog.get(wireId);
    return b ? { maxInputBytes: b.def.maxInputBytes, needsAmounts: b.def.needsAmounts, reservedOutcomes: b.def.reservedOutcomes } : null;
  };
}
