// D02 §6.1 정적 검증 규칙 V-01~V-24(V-03a~l·V-03c′·V-03j′·V-03j″·V-04a 포함). 레지스트리 CI와 엔진 로더가 같은 함수를 쓴다.
// 위반은 규칙 번호·스텝·타깃 이름만 담는다(값 없음).
import { ABORT, buildCfg, commitWindow, dominates, END, FALLOFF, hNode, IRREVERSIBLE_TYPES, isSynthetic, reachable, sccs, type Cfg, type EdgeKind } from './cfg.ts';
import { compileRe2, isAnchored, re2Problem } from './re2.ts';
import { schemaViolations } from './schema.ts';
import { isSecretEntry, type Cond, type Effect, type From, type PackageFiles, type PlaybookIR, type SelectorDict, type SelectorEntry, type Step, type StepOf, type Violation } from './types.ts';
import { SAVE_PDF_STRATEGIES } from './savepdf.ts';

/** 번들 결과 목록(V-07). 엔진 로더는 앱 내장 카탈로그(@sax/model BundleCatalog)에서 만든다. */
export interface BundleOutcomes {
  outcomes: string[];
  reserved: string[];
}

export interface ValidateOptions {
  /** wireId(`<id>_v<ver>`) → 결과. 없으면 decide를 쓰는 IR은 V-07 위반이다(fail-closed). */
  bundles?: ReadonlyMap<string, BundleOutcomes>;
  /** lookupsUsed의 조회 하위 패키지(id → 파일). verify가 부르는 조회 패키지는 여기 있어야 한다(V-22). */
  lookups?: ReadonlyMap<string, PackageFiles>;
}

export interface Analysis {
  cfg: Cfg;
  irreversible: Set<string>;
  /** X → G(X). V-03a를 통과한 X만. */
  gateOf: Map<string, string>;
  /** X → W(X). */
  windows: Map<string, Set<string>>;
  /** G → G 앞 readback 스텝 id들(V-03h 역추적). */
  readbackBefore: Map<string, string[]>;
}

const DATE_KEY = /Date$/;
/** D02 V-03h: 앱 내장 카드 필수 필드(공급자 = 내 사업자 포함). 카드 렌더링은 엔진·main 몫이고 여기서는 readback 범위를 본다. */
export const CARD_REQUIRED_FIELDS = ['supplierBizNo'] as const;

const refHead = (ref: string, scope: string): string | null => {
  const m = new RegExp(`^\\$${scope}\\.([A-Za-z0-9_]+)`).exec(ref);
  return m ? m[1]! : null;
};

/** 조건식의 모든 노드를 돈다. */
export function walkCond(c: Cond, f: (c: Cond) => void): void {
  f(c);
  if ('all' in c) c.all.forEach((x) => walkCond(x, f));
  else if ('any' in c) c.any.forEach((x) => walkCond(x, f));
  else if ('not' in c) walkCond(c.not, f);
}

export function condTargets(c: Cond): string[] {
  const out: string[] = [];
  walkCond(c, (x) => {
    if ('exists' in x) out.push(x.exists);
    else if ('textMatches' in x) out.push(x.textMatches.target);
  });
  return out;
}

/** 조건식의 연언 잎: all은 펼치고, any·not 아래는 넣지 않는다(V-03m: 반드시 평가되어 참이어야 하는 조건만). */
export function conjuncts(c: Cond): Cond[] {
  if ('all' in c) return c.all.flatMap(conjuncts);
  if ('any' in c || 'not' in c) return [];
  return [c];
}

/** V-03m 대상 fieldKey: 금액(…Amount)과 상대방 식별(사업자·등록번호). */
export const AMOUNT_KEY = /Amount$/;
export const COUNTERPART_KEY = /^counterpart(BizNo|RegNo)$/;
export const EMAIL_KEY = /^counterpartEmail$/;

const fromTarget = (f: From): string => ('selector' in f ? f.selector : 'regex' in f ? f.regex.target : f.a11y.target);

export function stepConds(s: Step): Cond[] {
  switch (s.type) {
    case 'assert':
      return [s.cond];
    case 'checkpoint':
      return [s.expect];
    case 'branch':
      return [s.on];
    case 'repeat':
      return [s.until];
    default:
      return [];
  }
}

/** 스텝이 셀렉터 사전에서 읽거나 누르는 모든 타깃(V-02·V-20·핫픽스 적격 계산). */
export function stepTargets(s: Step): Array<{ ref: string; role: 'target' | 'from' | 'scope' | 'cond' | 'region' | 'rowLabel' | 'confirmTarget' | 'wait' }> {
  const out: ReturnType<typeof stepTargets> = [];
  if ('target' in s && typeof s.target === 'string') out.push({ ref: s.target, role: 'target' });
  if (s.type === 'extract' || s.type === 'capture') out.push({ ref: fromTarget(s.from), role: 'from' });
  if (s.type === 'decide' && s.scope !== 'root') out.push({ ref: s.scope, role: 'scope' });
  if (s.type === 'human' && s.region) out.push({ ref: s.region, role: 'region' });
  if (s.type === 'wait' && s.for === 'selector' && s.value) out.push({ ref: s.value, role: 'wait' });
  if (s.type === 'submit' && s.signFlow?.rowLabel) out.push({ ref: s.signFlow.rowLabel, role: 'rowLabel' });
  if (s.type === 'submit' && s.signFlow?.confirmTarget) out.push({ ref: s.signFlow.confirmTarget, role: 'confirmTarget' });
  for (const c of stepConds(s)) for (const t of condTargets(c)) out.push({ ref: t, role: 'cond' });
  return out;
}

/** 랜드마크 사슬(가까운 것부터). 순환이면 멈춘다. */
export function landmarkChain(sel: SelectorDict, id: string): string[] {
  const out: string[] = [];
  let cur = sel.entries[id]?.landmark;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = sel.entries[cur]?.landmark;
  }
  return out;
}

/** 랜드마크 L의 서브트리에 든 항목(L 자신 포함). */
export function inLandmark(sel: SelectorDict, landmark: string): string[] {
  return Object.keys(sel.entries).filter((k) => k === landmark || landmarkChain(sel, k).includes(landmark));
}

/** V-03g·V-03k: 비가역 스텝 집합. */
export function irreversibleSteps(sel: SelectorDict, info: Cfg['info']): Set<string> {
  const out = new Set<string>();
  for (const [id, { step: s }] of info) {
    if (IRREVERSIBLE_TYPES.has(s.type)) out.add(id);
    else if ((s.type === 'click' || s.type === 'select') && sel.entries[s.target]?.commits) out.add(id);
    else if (s.type === 'press' && s.target) {
      const e = sel.entries[s.target];
      if (e?.commits) out.add(id);
      else if (s.key === 'Enter' && e && inLandmark(sel, e.landmark).some((k) => sel.entries[k]!.commits)) out.add(id);
    }
  }
  return out;
}

const followUpOf = (s: Step): string | undefined => (s.type === 'human_commit' || s.type === 'send_email' ? s.followUpOf : undefined);

/** V-13: 사용자 데이터 형식 리터럴(NFKC·유사 문자 치환 뒤). */
const HOMOGLYPH: Record<string, string> = { О: 'O', о: 'o', І: 'I', і: 'i', 'ㅡ': '-', '—': '-', '–': '-', '‐': '-', '−': '-' };
const USER_DATA = [
  /\d{3}-?\d{2}-?\d{5}/, // 사업자등록번호
  /\d{6}-?[1-8]\d{6}/, // 주민·외국인등록번호
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // 이메일
  /01[016789]-?\d{3,4}-?\d{4}/, // 휴대전화
  /\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}/, // 카드
  /\d{10,}/, // 계좌·긴 숫자
];
export function looksLikeUserData(v: string): boolean {
  const n = [...v.normalize('NFKC')].map((c) => HOMOGLYPH[c] ?? c).join('').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  return USER_DATA.some((r) => r.test(n));
}

const UNIVERSAL_SAMPLES = ['', 'a', '아무 문장 123', 'confirm? 확인'];

/** 메인 진입점: 한 패키지의 스키마 + V-01~V-24. 통과하면 빈 배열. */
export function validatePackage(pkg: PackageFiles, opts: ValidateOptions = {}): Violation[] {
  const v: Violation[] = [];
  v.push(...schemaViolations('playbook-ir', pkg.playbook), ...schemaViolations('selectors', pkg.selectors), ...schemaViolations('manifest', pkg.manifest));
  if (v.length) return v; // 스키마가 깨진 문서의 의미 검사는 하지 않는다(타입 가정이 깨진다)
  v.push(...semanticViolations(pkg, opts).violations);
  return v;
}

export function semanticViolations(pkg: PackageFiles, opts: ValidateOptions = {}): { violations: Violation[]; analysis: Analysis } {
  const { playbook: ir, selectors: sel, strings, manifest } = pkg;
  const v: Violation[] = [];
  const bad = (rule: string, message: string, step?: string, target?: string) => v.push({ rule, message, ...(step ? { step } : {}), ...(target ? { target } : {}) });

  const pre = buildCfg(ir);
  const irreversible = irreversibleSteps(sel, pre.info);
  const cfg = buildCfg(ir, { irreversible });
  for (const p of cfg.problems) bad(p.rule, p.message, p.step);
  const { info } = cfg;
  const steps = [...info.values()].map((i) => i.step);
  const entry = (t: string) => sel.entries[t];

  // ---- V-01: 정규식(RE2) ----
  const re = (rule: string, pattern: string | undefined, where: string, step?: string) => {
    if (pattern === undefined) return;
    const p = re2Problem(pattern);
    if (p) bad(rule, `${where}: 정규식 ${p}`, step);
  };
  for (const [k, e] of Object.entries(sel.entries)) re('V-01', e.namePattern, `selectors ${k}.namePattern`);
  for (const ce of sel.commitEndpoints) re('V-01', ce.match.pathPattern, 'commitEndpoints.pathPattern');
  for (const ke of sel.knownEndpoints) re('V-01', ke.pathPattern, 'knownEndpoints.pathPattern');
  const patternRefs = new Set<string>();
  for (const s of steps) {
    for (const c of stepConds(s)) walkCond(c, (x) => 'textMatches' in x && patternRefs.add(x.textMatches.patternRef));
    if ((s.type === 'extract' || s.type === 'capture') && 'regex' in s.from) patternRefs.add(s.from.regex.patternRef);
    if (s.type === 'human') re('V-01', s.inputSpec?.pattern, 'human.inputSpec.pattern', s.id);
    if (s.type === 'verify') for (const f of s.failSignals ?? []) re('V-01', f.text, 'verify.failSignals.text', s.id);
    if (s.type === 'verify' && s.lookup.rowVerdict) for (const k of [s.lookup.rowVerdict.sent, s.lookup.rowVerdict.notSent]) {
      if (strings[k] === undefined) bad('V-01', `verify.rowVerdict ${k}가 strings에 없음`, s.id);
      else re('V-01', strings[k], `strings ${k}(rowVerdict)`, s.id);
    }
    if (s.type === 'submit' && s.expectConfirm && strings[s.expectConfirm] !== undefined) re('V-01', strings[s.expectConfirm], `strings ${s.expectConfirm}(expectConfirm)`, s.id);
  }
  for (const c of [...(ir.preconditions ?? []), ...ir.postconditions]) walkCond(c, (x) => 'textMatches' in x && patternRefs.add(x.textMatches.patternRef));
  for (const k of patternRefs) {
    if (strings[k] === undefined) bad('V-01', `patternRef ${k}가 strings에 없음`);
    else re('V-01', strings[k], `strings ${k}`);
  }
  // 전제·사후조건 전용 조건(§4.1)은 스텝 조건에 쓸 수 없다.
  for (const s of steps) for (const c of stepConds(s)) walkCond(c, (x) => ('inputVerified' in x || 'profileHas' in x || 'artifact' in x) && bad('V-01', '전제·사후조건 전용 조건을 스텝에서 씀', s.id));

  // ---- V-02: 타깃 존재·속성, strings 키 존재 ----
  for (const s of steps) {
    for (const t of stepTargets(s)) if (!entry(t.ref)) bad('V-02', `${t.role} ${t.ref}가 셀렉터 사전에 없음`, s.id, t.ref);
    const keys: string[] = [];
    if (s.label) keys.push(s.label);
    if (s.type === 'gate') keys.push(s.card);
    if (s.type === 'human' || s.type === 'human_commit') keys.push(s.prompt);
    if (s.type === 'handoff') keys.push(s.reason);
    if (s.type === 'submit' && s.expectConfirm) keys.push(s.expectConfirm);
    if (s.type === 'wait' && s.for === 'text' && s.value) keys.push(s.value);
    for (const k of keys) if (strings[k] === undefined) bad('V-02', `strings 키 ${k}가 없음`, s.id);
  }
  if (strings[manifest.title] === undefined) bad('V-02', `manifest.title ${manifest.title}가 strings에 없음`);
  const fieldKeyEntries = new Map<string, string[]>();
  for (const [k, e] of Object.entries(sel.entries)) if (e.fieldKey && e.fieldKey !== '_ignore') fieldKeyEntries.set(e.fieldKey, [...(fieldKeyEntries.get(e.fieldKey) ?? []), k]);
  for (const s of steps) {
    if (s.type === 'secret_fill') {
      const e = entry(s.target);
      if (e && e.secretKind !== s.secret) bad('V-02', `secret_fill.secret과 타깃 secretKind가 다름`, s.id, s.target);
      // 독립 secret_fill은 로그인 구간 칸만(sign 용도 칸은 signFlow·sign 흐름 안에서만, ADR-026).
      if (e?.secretKind && e.secretPurpose !== 'login') bad('V-02', `secretPurpose ${e.secretPurpose ?? '없음'} 칸을 독립 secret_fill로 씀`, s.id, s.target);
    }
    if (s.type === 'human' && s.kind === 'secret' && s.target && entry(s.target) && !entry(s.target)!.secretKind) bad('V-02', 'human:secret 타깃이 비밀 칸이 아님', s.id, s.target);
    if (s.type === 'submit') {
      const e = entry(s.target);
      if (e && !e.commits) bad('V-03g', 'submit 타깃이 commits:true가 아님', s.id, s.target);
      const ct = s.signFlow?.confirmTarget;
      if (ct && entry(ct)) {
        if (!entry(ct)!.commits) bad('V-02', 'signFlow.confirmTarget이 commits:true가 아님', s.id, ct);
        else if (e && entry(ct)!.commitEffect !== e.commitEffect) bad('V-02', 'signFlow.confirmTarget의 commitEffect가 submit 타깃과 다름', s.id, ct);
      }
      const rl = s.signFlow?.rowLabel;
      if (rl && isSecretEntry(entry(rl))) bad('V-02', 'signFlow.rowLabel이 비밀 칸', s.id, rl);
    }
    if (s.type === 'readback') for (const f of s.fields) if (!fieldKeyEntries.has(f)) bad('V-02', `readback 필드 ${f}의 fieldKey 항목이 사전에 없음`, s.id);
    if (s.type === 'assert') walkCond(s.cond, (x) => 'fieldsFilled' in x && x.fieldsFilled.fields.forEach((f) => !fieldKeyEntries.has(f) && bad('V-02', `fieldsFilled ${f}의 항목이 없음`, s.id)));
  }

  /** 선택 입력: required가 아니고 기본값도 없다(V-03m 이메일). */
  const optionalInput = (n: string | null) => {
    const d = n ? ir.inputs[n] : undefined;
    return !!d && d.required !== true && d.default === undefined;
  };

  // ---- V-03: 커밋 구간 ----
  const gates = steps.filter((s): s is StepOf<'gate'> => s.type === 'gate');
  const gateOf = new Map<string, string>();
  const windows = new Map<string, Set<string>>();
  const readbackBefore = new Map<string, string[]>();
  for (const x of irreversible) {
    const s = info.get(x)!.step;
    const gs = gates.filter((g) => g.authorizes.includes(x));
    if (gs.length !== 1) {
      bad(s.type === 'click' || s.type === 'press' || s.type === 'select' ? 'V-03g' : 'V-03a', `비가역 스텝을 허가하는 게이트가 ${gs.length}개`, x);
      continue;
    }
    gateOf.set(x, gs[0]!.id);
  }
  for (const g of gates) {
    // V-03i: 주 비가역 정확히 1개 + 그 후속.
    const auth = g.authorizes.filter((a) => info.has(a));
    for (const a of g.authorizes) if (!info.has(a)) bad('V-03i', `authorizes ${a}가 없는 스텝`, g.id);
    const notIrr = auth.filter((a) => !irreversible.has(a));
    if (notIrr.length) bad('V-03i', `비가역이 아닌 스텝 ${notIrr.join(',')}를 authorizes`, g.id);
    const primaries = auth.filter((a) => irreversible.has(a) && !followUpOf(info.get(a)!.step));
    if (primaries.length !== 1) bad('V-03i', `주 비가역이 ${primaries.length}개`, g.id);
    else for (const a of auth) {
      const fu = followUpOf(info.get(a)!.step);
      if (fu && fu !== primaries[0]) bad('V-03i', `${a}의 followUpOf가 이 게이트의 주 비가역이 아님`, g.id);
    }
    // V-03h: G 앞 readback, R→G 사이 assert만.
    const rbs: string[] = [];
    const seen = new Set<string>();
    const stack = [g.id];
    let ok = true;
    while (stack.length && ok) {
      const n = stack.pop()!;
      for (const [p] of cfg.pred.get(n) ?? []) {
        if (p === hNode(n) || seen.has(p)) continue;
        if (cfg.pred.get(n)!.get(p) === 'rewind' || cfg.pred.get(n)!.get(p) === 'recover') continue;
        seen.add(p);
        const ps = info.get(p)?.step;
        if (ps?.type === 'readback') rbs.push(p);
        else if (ps?.type === 'assert') stack.push(p);
        else {
          bad('V-03h', `게이트 앞 readback→gate 사이에 ${ps?.type ?? p}가 있음`, g.id);
          ok = false;
          break;
        }
      }
    }
    if (ok && !rbs.length) bad('V-03h', '게이트 앞에 readback이 없음', g.id);
    readbackBefore.set(g.id, rbs);
    const rbFields = new Set(rbs.flatMap((r) => (info.get(r)!.step as StepOf<'readback'>).fields));
    const primary = primaries[0];
    if (primary && !followUpOf(info.get(primary)!.step)) for (const f of CARD_REQUIRED_FIELDS) if (rbs.length && !rbFields.has(f) && hasTargetLandmark(info.get(primary)!.step)) bad('V-03h', `카드 필수 필드 ${f}가 readback에 없음`, g.id);
    // V-03j′: 날짜형 fieldKey가 있으면 입력값 대조 assert가 R→G 사이에 필수.
    const asserts = [...seen].map((n) => info.get(n)?.step).filter((s): s is StepOf<'assert'> => s?.type === 'assert');
    const dateFields = [...rbFields].filter((f) => DATE_KEY.test(f) || (fieldKeyEntries.get(f) ?? []).some((k) => sel.entries[k]!.inputType === 'date'));
    for (const f of dateFields) {
      const has = asserts.some((a) => 'readbackEquals' in a.cond && a.cond.readbackEquals.fieldKey === f && a.cond.readbackEquals.ref.startsWith('$inputs.'));
      if (!has) bad('V-03j′', `날짜 필드 ${f}의 readbackEquals{$inputs} assert가 게이트 앞에 없음`, g.id);
    }
    // V-03m(팀장 결정 2026-11-07, D02 §8 s19f 일반화): 게이트가 보낼 금액·상대방 fieldKey는 R→G 사이 assert에서 $inputs와 대조해야 한다.
    // 합계처럼 입력 인자가 없는 금액은 sumEquals(s19d)의 total이고 parts가 모두 $inputs 대조된 것이면 된다.
    // assert의 all 안은 셈하고 any·not 안은 셈하지 않는다(그 대조가 실패해도 통과할 수 있다).
    const leaves = asserts.flatMap((a) => conjuncts(a.cond));
    const inputEq = new Set(leaves.flatMap((c) => ('readbackEquals' in c && c.readbackEquals.ref.startsWith('$inputs.') ? [c.readbackEquals.fieldKey] : [])));
    const sums = leaves.flatMap((c) => ('sumEquals' in c ? [c.sumEquals] : []));
    const covered = (f: string) => inputEq.has(f) || sums.some((x) => x.total === f && x.parts.every((p) => inputEq.has(p)));
    for (const f of rbFields) if ((AMOUNT_KEY.test(f) || COUNTERPART_KEY.test(f)) && !covered(f)) bad('V-03m', `금액·상대방 필드 ${f}의 $inputs 대조 assert(readbackEquals 또는 대조된 parts의 sumEquals)가 게이트 앞에 없음`, g.id);
    // 받는 이메일(팀장 결정 2026-11-07): 입력이 있으면 readbackEquals{$inputs}, 없으면 비었음(readbackEmpty) 중 하나가 반드시 있어야 한다.
    // 선택 입력(required 아님·기본값 없음)과의 대조는 ifAbsent:'empty'여야 입력이 빈 실행도 덮는다.
    for (const f of rbFields) {
      if (!EMAIL_KEY.test(f)) continue;
      const eqs = leaves.flatMap((c) => ('readbackEquals' in c && c.readbackEquals.fieldKey === f && c.readbackEquals.ref.startsWith('$inputs.') ? [c.readbackEquals] : []));
      const empty = leaves.some((c) => 'readbackEmpty' in c && c.readbackEmpty === f);
      if (!eqs.length && !empty) bad('V-03m', `받는 이메일 필드 ${f}의 입력 대조(readbackEquals{$inputs}) 또는 비었음(readbackEmpty) assert가 게이트 앞에 없음`, g.id);
      for (const e of eqs) if (optionalInput(refHead(e.ref, 'inputs')) && e.ifAbsent !== 'empty') bad('V-03m', `받는 이메일 필드 ${f}가 선택 입력과 대조하는데 ifAbsent:'empty'가 없음(입력이 빈 실행을 덮지 않음)`, g.id);
    }
  }
  for (const [x, g] of gateOf) {
    const s = info.get(x)!.step;
    const fu = followUpOf(s);
    // V-03b. 후속 비가역은 관측 간선(R-C2)을 뺀 그래프로 본다: 핸드오프 재개 뒤의 verify committed에서는
    // 후속 토큰을 발급하지 않으므로(D03 §3 후속 토큰은 같은 커밋 구간의 committed 전이에서만) 그 길로는 Y를 실행할 수 없다.
    if (!(fu ? (cfg.domData.get(x)?.has(g) ?? false) : dominates(cfg, g, x))) bad('V-03b', `게이트 ${g}가 ${x}를 지배하지 않음`, x);
    const w = commitWindow(cfg, g, x, { followUp: !!fu });
    windows.set(x, w);
    if (fu) {
      // V-03c′
      const verifyOfFu = (() => {
        const f = info.get(fu)?.step;
        return f && 'verify' in f && typeof f.verify === 'string' ? f.verify : undefined;
      })();
      for (const n of w) {
        if (n === g || n === x || n === fu) continue;
        const ns = info.get(n)?.step;
        if (!ns) {
          bad('V-03c′', `후속 비가역 구간에 합성 노드 ${n}(핸드오프·비밀 창)`, x);
          continue;
        }
        const allowed =
          (ns.type === 'verify' && n === verifyOfFu) ||
          ns.type === 'capture' || ns.type === 'save_pdf' || ns.type === 'wait' || ns.type === 'assert' || ns.type === 'readback' ||
          (ns.type === 'extract' && ns.readback === true) ||
          (ns.type === 'branch' && branchCondOk(ns.on));
        if (!allowed) bad('V-03c′', `후속 비가역 구간에 ${ns.type}`, x, n);
      }
      const preds = [...(cfg.pred.get(x)?.keys() ?? [])].filter((p) => p !== hNode(x));
      if (!preds.length || preds.some((p) => info.get(p)?.step.type !== 'readback')) bad('V-03c′', '후속 비가역 직전에 readback이 없음', x);
    } else {
      // V-03c. 구간 안 스텝 자신의 onFail 핸드오프 재개(H:m → m, m ∈ W)는 V-03f가 요구하는 모양이고, HandedOff 진입이 토큰을
      // 폐기하므로(R-G2) 그 길로는 X를 실행할 수 없다(V-03d와 같은 판단). 그 노드는 구간 스텝으로 세지 않는다.
      for (const n of w) {
        if (n === g || n === x) continue;
        if (n.startsWith('H:') && w.has(n.slice(2)) && n === hNode(n.slice(2)) && cfg.succ.get(n)?.has(n.slice(2))) continue;
        const ns = info.get(n)?.step;
        if (!ns) bad('V-03c', `커밋 구간에 합성 노드 ${n}(핸드오프·비밀 창·사람 입력)`, x);
        else if (!(ns.type === 'wait' || ns.type === 'assert' || (ns.type === 'extract' && ns.readback === true))) bad('V-03c', `커밋 구간에 ${ns.type}`, x, n);
      }
    }
    // V-03d: 단일 진입(관측 간선 포함). 구간 안 스텝 자신의 핸드오프 재개(H:n → n)는 토큰이 폐기된 뒤라 진입으로 보지 않는다.
    for (const n of w) {
      if (n === g) continue;
      for (const [p, k] of cfg.pred.get(n) ?? []) {
        if (w.has(p) || p === hNode(n)) continue;
        // 후속 비가역: 핸드오프 재개·관측 간선으로 들어오는 길에서는 후속 토큰이 없다(R-G2, commitWindow 설명). 실행기가 집행한다(M2-3).
        if (fu && (k === 'observed' || p.startsWith('H:') || p.startsWith('SECRET:'))) continue;
        bad('V-03d', `커밋 구간 ${n}에 구간 밖 ${p}에서 들어오는 간선(${k})`, x);
      }
    }
    // V-03e
    if (info.get(x)!.repeats.length) bad('V-03e', '비가역 스텝이 repeat 안에 있음', x);
    // V-03f
    // W(X)와 W(Y) 모두 구간 안 모든 스텝(후속 비가역 Y의 구간에 낀 verify·capture·wait 등 포함, D02 V-03f).
    for (const n of w) {
      if (n === g) continue;
      const ns = info.get(n)?.step;
      if (!ns || ns.type === 'gate') continue;
      const o = ns.onFail ?? ir.recovery?.default;
      if (!o || (o.retry ?? 0) !== 0 || (o.then !== 'handoff' && o.then !== 'abort')) bad('V-03f', `onFail이 {retry:0, then:handoff|abort}가 아님`, n);
    }
    if ('verify' in s && typeof s.verify === 'string') {
      const vs = info.get(s.verify)?.step;
      if (vs?.type === 'verify') {
        const t = vs.on.not_committed;
        if (info.has(t) && reachable(t, fu ? withoutObserved(cfg) : cfg.succ, new Set([g])).has(x)) bad('V-03f', `verify.not_committed에서 게이트를 지나지 않고 ${x}로 돌아옴`, s.verify);
      }
    }
    // V-03j: 커밋 랜드마크 안 fieldKey 전부가 readback에.
    const tgt = 'target' in s && typeof s.target === 'string' ? s.target : undefined;
    const rbs = readbackBefore.get(g) ?? [];
    if (tgt && entry(tgt) && rbs.length && !fu) {
      const rbFields = new Set(rbs.flatMap((r) => (info.get(r)!.step as StepOf<'readback'>).fields));
      for (const k of inLandmark(sel, entry(tgt)!.landmark)) {
        const fk = sel.entries[k]!.fieldKey;
        if (fk && fk !== '_ignore' && !rbFields.has(fk)) bad('V-03j', `커밋 랜드마크의 fieldKey ${fk}가 readback에 없음`, x, k);
      }
    }
  }
  // V-03g: commits 타깃을 누르는 click·press·select는 submit으로만(V-04: verify가 없다).
  // V-03k는 irreversibleSteps가 press Enter를 비가역으로 계산하는 것으로 집행된다.
  // V-03l: 게이트를 지배하는 체크포인트는 url + reload.
  for (const s of steps) {
    if (s.type !== 'checkpoint') continue;
    if (gates.some((g) => dominates(cfg, s.id, g.id)) && (!s.url || s.reentry !== 'reload')) bad('V-03l', '게이트를 지배하는 체크포인트에 url·reentry:reload가 없음', s.id);
  }
  // V-03j″: 실패 신호 (css, ^…$ 문구) 쌍.
  for (const s of steps) if (s.type === 'verify') for (const f of s.failSignals ?? []) if (!f.css.trim() || !isAnchored(f.text)) bad('V-03j″', '실패 신호 항목에 앵커된 문구가 없음', s.id);

  // ---- V-04 ----
  for (const x of irreversible) {
    const s = info.get(x)!.step;
    if (s.type === 'click' || s.type === 'press' || s.type === 'select') {
      bad('V-04', `${s.type}로 비가역 타깃을 누름(submit·verify 필요)`, x);
      continue;
    }
    if (!('intent' in s) || s.intent !== '$intent.id') bad('V-04', 'intent: $intent.id 없음', x);
    const vid = 'verify' in s ? s.verify : undefined;
    const vs = vid ? info.get(vid)?.step : undefined;
    if (vs?.type !== 'verify') {
      bad('V-04', 'verify가 verify 스텝이 아님', x);
      continue;
    }
    const g = gateOf.get(x);
    const rbFields = new Set((g ? readbackBefore.get(g) ?? [] : []).flatMap((r) => (info.get(r)!.step as StepOf<'readback'>).fields));
    const fu = followUpOf(s);
    if (!fu) {
      if (vs.lookup.baseline !== 'pre_gate_snapshot') bad('V-04', 'verify.baseline이 pre_gate_snapshot이 아님', vid);
      for (const [k, ref] of Object.entries(vs.lookup.match)) {
        const f = refHead(ref, 'readback');
        if (!f || !rbFields.has(f)) bad('V-04', `verify.match ${k}가 게이트 앞 readback 값($readback.*)이 아님`, vid);
      }
    } else if (vs.lookup.baseline === 'none' && !Object.values(vs.lookup.match).some((r) => boundByVerify(steps, refHead(r, 'vars')))) {
      bad('V-04', 'baseline:none인데 앞선 verify.bind 값을 키로 쓰지 않음', vid);
    }
  }
  // ---- V-04a(팀장 결정 2026-11-06) ----
  // 비가역 X마다 자기 verify. 두 X의 verify 필드가 같은 스텝을 가리키면 그 판정을 어느 X의 원장 행에 붙일지 정할 수 없다
  // (잘못 붙이면 중복 발급). 후속 Y가 W(Y) 안에서 Xc의 verify를 다시 지나는 것(V-03c′)은 X.verify 필드가 아니라 허용한다.
  const xByVerify = new Map<string, string>();
  for (const x of irreversible) {
    const s = info.get(x)!.step;
    const vid = 'verify' in s && typeof s.verify === 'string' ? s.verify : undefined;
    if (!vid) continue;
    const first = xByVerify.get(vid);
    if (first) bad('V-04a', `${first}와 같은 verify를 가리킴`, x, vid);
    else xByVerify.set(vid, x);
  }
  // baseline:none 일반 규칙(§4.4)
  for (const s of steps) if (s.type === 'verify' && s.lookup.baseline === 'none' && !Object.values(s.lookup.match).some((r) => boundByVerify(steps, refHead(r, 'vars')))) bad('V-04', 'baseline:none은 앞선 verify.bind 값을 키로 쓸 때만', s.id);
  // V-03n(팀장 결정 2026-11-06): 사후 부수효과 확인(baseline:none)은 행이 있는 것만으로 성공이 아니다(메일 '전송실패' 행도 행이다).
  // 그래서 상태 문구 판정 rowVerdict가 필수다. verify별 상한 maxMs는 이 사후 확인에만 쓸 수 있다(주 비가역 verify는 앱 하한 300초를 지킨다).
  for (const s of steps) {
    if (s.type !== 'verify') continue;
    if (s.lookup.baseline === 'none' && !s.lookup.rowVerdict) bad('V-03n', 'baseline:none 사후 확인 verify에 rowVerdict가 없음', s.id);
    if (s.lookup.maxMs !== undefined && s.lookup.baseline !== 'none') bad('V-03n', 'verify.lookup.maxMs는 baseline:none 사후 확인에만', s.id);
  }

  // ---- V-05 ----
  for (const [id, i] of info) if (i.step.type === 'repeat' && i.repeats.length >= 2) bad('V-05', 'repeat 중첩이 2를 넘음', id);

  // ---- V-06 ----
  for (const s of steps) {
    const url = s.type === 'goto' ? s.url : s.type === 'checkpoint' ? s.url : undefined;
    if (url === undefined) continue;
    const p = urlProblem(url, manifest.domains);
    if (p) bad('V-06', p, s.id);
  }

  // ---- V-07 ----
  for (const s of steps) {
    if (s.type !== 'decide') continue;
    const b = opts.bundles?.get(s.bundle);
    if (!b) {
      bad('V-07', `번들 ${s.bundle}가 앱 내장 카탈로그에 없음`, s.id);
      continue;
    }
    const want = new Set(b.outcomes.filter((o) => !b.reserved.includes(o)));
    const got = new Set(Object.keys(s.on));
    for (const o of want) if (!got.has(o)) bad('V-07', `decide.on에 결과 ${o}가 없음`, s.id);
    for (const o of got) if (!want.has(o)) bad('V-07', `decide.on의 ${o}는 번들 결과가 아니거나 예약 결과`, s.id);
    // V-07b
    const u = s.on.unknown;
    if (u && u !== 'handoff' && u !== 'abort') {
      const back = info.has(u) && reachable(u, explicitSucc(cfg), irreversible).has(s.id);
      if (!back || !s.loopGuard) bad('V-07b', 'unknown 목적지는 handoff·abort 또는 loopGuard 있는 같은 decide로 돌아오는 대기 루프', s.id);
    }
  }

  // ---- V-08 ----
  for (const s of steps) if (s.type === 'submit' && s.signFlow && Object.values(s.signFlow.steps ?? {}).some((a) => a?.includes('secret_fill:security_card')) && !s.signFlow.rowLabel) bad('V-08', 'signFlow 보안카드에 rowLabel 없음', s.id);

  // ---- V-10 ----
  const humans = new Map(steps.filter((s): s is StepOf<'human'> => s.type === 'human').map((s) => [s.id, s]));
  for (const h of humans.values()) {
    if (h.kind !== 'captcha') continue;
    const n = info.get(h.id)!.next;
    const ns = n ? info.get(n)?.step : undefined;
    if (ns?.type !== 'fill' || ns.value !== `$human.${h.id}`) bad('V-10', '캡차 다음 스텝이 $human 값을 넣는 fill이 아님', h.id);
  }

  // ---- V-11: 도달성 ----
  const fromEntry = reachable(cfg.entry, cfg.succ);
  for (const id of info.keys()) if (!fromEntry.has(id)) bad('V-11', '진입점에서 도달할 수 없음', id);
  if (fromEntry.has(FALLOFF)) {
    const lastFall = [...info.keys()].filter((id) => cfg.succ.get(id)?.has(FALLOFF));
    for (const id of lastFall) bad('V-11', '최상위 끝에서 end 없이 끝남', id);
  }
  const rev = new Map<string, string[]>();
  for (const [a, m] of cfg.succ) for (const b of m.keys()) rev.set(b, [...(rev.get(b) ?? []), a]);
  const canFinish = new Set<string>([END, ABORT]);
  const st = [END, ABORT];
  while (st.length) {
    const n = st.pop()!;
    for (const p of rev.get(n) ?? []) if (!canFinish.has(p)) {
      canFinish.add(p);
      st.push(p);
    }
  }
  for (const n of fromEntry) if (!canFinish.has(n) && n !== FALLOFF) bad('V-11', `${n}에서 end·abort에 닿을 수 없음`, isSynthetic(n) ? undefined : n);

  // ---- V-12 ----
  const kinds = (xs: string[]) => [...xs].sort().join(',');
  if (kinds(manifest.profileKinds) !== kinds(ir.profileKinds)) bad('V-12', 'manifest와 IR의 profileKinds가 다름');
  if (manifest.portal !== ir.portal || sel.portal !== ir.portal) bad('V-12', 'manifest·IR·selectors의 portal이 다름');
  if (manifest.id !== ir.id || manifest.version !== ir.version) bad('V-12', 'manifest와 IR의 id·version이 다름');
  const usesBizProfile = JSON.stringify(ir).includes('$profile.bizNo');
  if (usesBizProfile && ir.profileKinds.includes('personal')) bad('V-12', '$profile.bizNo를 쓰는데 personal 프로필 허용');
  for (const s of steps) if (s.type === 'secret_fill' && s.secret === 'security_card' && ir.profileKinds.includes('personal') && !ir.profileKinds.includes('business')) bad('V-12', '보안카드는 사업자 프로필 흐름', s.id);

  // ---- V-13·V-21: 상수 ----
  for (const s of steps) {
    const c = s.type === 'fill' ? s.value : s.type === 'select' ? s.option : undefined;
    if (c === undefined || c.startsWith('$')) continue;
    const e = entry((s as StepOf<'fill'> | StepOf<'select'>).target);
    if (!e?.allowedConstants?.includes(c)) bad('V-21', '상수가 타깃 allowedConstants에 없음', s.id);
    if (looksLikeUserData(c)) bad('V-13', '상수에 사용자 데이터 형식 리터럴', s.id);
  }
  for (const [k, e] of Object.entries(sel.entries)) for (const c of e.allowedConstants ?? []) if (looksLikeUserData(c)) bad('V-13', 'allowedConstants에 사용자 데이터 형식 리터럴', undefined, k);
  for (const s of steps) for (const c of stepConds(s)) walkCond(c, (x) => 'varEquals' in x && typeof x.varEquals.value === 'string' && looksLikeUserData(x.varEquals.value) && bad('V-13', 'varEquals 상수에 사용자 데이터 형식', s.id));

  // ---- V-14 ----
  const effects = new Set<Effect>();
  for (const x of irreversible) {
    const s = info.get(x)!.step;
    if (s.type === 'send_email') effects.add('send');
    const t = 'target' in s && typeof s.target === 'string' ? entry(s.target) : undefined;
    if (t?.commitEffect) effects.add(t.commitEffect);
    if (s.type === 'press' && t) for (const k of inLandmark(sel, t.landmark)) if (sel.entries[k]!.commitEffect) effects.add(sel.entries[k]!.commitEffect!);
  }
  for (const e of effects) {
    if (!manifest.effects.includes(e)) bad('V-14', `manifest.effects에 ${e}가 없음`);
    if (!ir.effects.includes(e)) bad('V-14', `IR effects에 ${e}가 없음`);
  }
  for (const e of ir.effects) if (!manifest.effects.includes(e)) bad('V-14', `IR effects ${e}가 manifest에 없음`);

  // ---- V-15: 값 참조 ----
  checkRefs(ir, cfg, steps, irreversible, bad);

  // ---- V-17 ----
  const cpNames = steps.filter((s): s is StepOf<'checkpoint'> => s.type === 'checkpoint').map((s) => s.name);
  for (const n of new Set(cpNames)) if (cpNames.filter((x) => x === n).length > 1) bad('V-17', `체크포인트 이름 ${n} 중복`);

  // ---- V-18: repeat 밖 순환은 loopGuard ----
  checkLoops(cfg, bad);

  // ---- V-20: 비밀 칸 읽기 금지 ----
  const secretIds = new Set(Object.entries(sel.entries).filter(([, e]) => isSecretEntry(e)).map(([k]) => k));
  for (const s of steps) {
    for (const t of stepTargets(s)) {
      if (!secretIds.has(t.ref)) continue;
      const allowed = t.role === 'target' && (s.type === 'secret_fill' || (s.type === 'human' && s.kind === 'secret'));
      if (!allowed) bad('V-20', `비밀 칸을 ${s.type}.${t.role}로 참조`, s.id, t.ref);
    }
    if (s.type === 'decide') {
      const scopeAll = s.scope === 'root' ? Object.keys(sel.entries) : inLandmark(sel, s.scope);
      const hit = [...secretIds].find((k) => scopeAll.includes(k) || (s.scope === 'root' ? true : landmarkChain(sel, k).includes(s.scope)));
      if (hit) bad('V-20', 'decide.scope가 비밀 칸의 랜드마크를 포함', s.id, hit);
    }
  }
  for (const [k, e] of Object.entries(sel.entries)) {
    if (!e.readbackOf) continue;
    const src = fieldKeyEntries.get(e.readbackOf) ?? [];
    if (src.some((x) => secretIds.has(x))) bad('V-20', 'readbackOf가 비밀 칸을 가리킴', undefined, k);
  }

  // ---- V-22: 조회 하위 플레이북 ----
  for (const s of steps) {
    if (s.type !== 'verify') continue;
    const used = manifest.lookupsUsed.find((l) => l.id === s.lookup.playbook);
    if (!used) {
      bad('V-22', `verify.lookup.playbook ${s.lookup.playbook}가 manifest.lookupsUsed에 없음`, s.id);
      continue;
    }
    const lp = opts.lookups?.get(used.id);
    if (!lp) bad('V-22', `조회 패키지 ${used.id}가 설치되어 있지 않음`, s.id);
    else if (lp.manifest.version !== used.version) bad('V-22', `조회 패키지 ${used.id}의 버전이 lookupsUsed와 다름`, s.id);
  }
  if (manifest.kind === 'lookup') v.push(...lookupViolations(pkg, cfg));

  // ---- V-23 ----
  for (const s of steps) if (s.type === 'save_pdf' && s.nameTemplate !== undefined && nameTemplateProblem(s.nameTemplate)) bad('V-23', `nameTemplate ${nameTemplateProblem(s.nameTemplate)}`, s.id);
  // ---- V-23a: Phase 1 엔진이 하는 save_pdf strategy만(print·page_pdf). 그 밖은 실행 중에 터지지 않게 로드 때 거부(팀장 결정 2026-11-06) ----
  for (const s of steps) if (s.type === 'save_pdf' && !SAVE_PDF_STRATEGIES.has(s.strategy)) bad('V-23a', `save_pdf strategy ${s.strategy}는 이 엔진이 지원하지 않음(print·page_pdf만)`, s.id);

  // ---- V-24 ----
  for (const s of steps) {
    if (s.type !== 'submit' || !s.expectConfirm) continue;
    const p = strings[s.expectConfirm];
    if (p === undefined) continue;
    if (!isAnchored(p)) {
      bad('V-24', 'expectConfirm 정규식이 ^…$ 앵커가 아님', s.id);
      continue;
    }
    let r: RegExp;
    try {
      r = compileRe2(p);
    } catch {
      continue; // V-01이 이미 보고
    }
    const inner = p.slice(1, -1);
    if (/^(\.\*|\.\+|\[\\s\\S\][*+]|\(\.\*\)|\(\.\+\))$/.test(inner) || UNIVERSAL_SAMPLES.some((x) => x === '' && r.test(x)) || UNIVERSAL_SAMPLES.filter((x) => r.test(x)).length >= 3) bad('V-24', 'expectConfirm이 빈 문자열이나 임의 문장에 맞음', s.id);
  }

  return { violations: v, analysis: { cfg, irreversible, gateOf, windows, readbackBefore } };
}

function withoutObserved(cfg: Cfg): Cfg['succ'] {
  return new Map([...cfg.succ].map(([a, m]) => [a, new Map([...m].filter(([, k]) => k !== 'observed'))] as const));
}

/** 명시 간선만(암묵 세션 복귀·되감기·복구·관측 간선 제외). V-07b 대기 루프 판정용. */
function explicitSucc(cfg: Cfg): Cfg['succ'] {
  const keep = new Set<EdgeKind>(['fall', 'body', 'out', 'fail', 'resume']);
  return new Map([...cfg.succ].map(([a, m]) => [a, new Map([...m].filter(([b, k]) => keep.has(k) && b !== a && !(a.startsWith('H:') && a === hNode(b))))] as const));
}

const hasTargetLandmark = (s: Step) => 'target' in s && typeof s.target === 'string';

function branchCondOk(c: Cond): boolean {
  let ok = true;
  walkCond(c, (x) => {
    if ('all' in x || 'any' in x || 'not' in x || 'inputPresent' in x || 'varSet' in x) return;
    ok = false;
  });
  return ok;
}

function boundByVerify(steps: Step[], name: string | null): boolean {
  return !!name && steps.some((s) => s.type === 'verify' && s.lookup.bind?.approvalNo === name);
}

export function urlProblem(url: string, domains: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'URL 파싱 실패';
  }
  if (u.protocol !== 'https:') return 'https가 아님';
  if (u.username || u.password) return 'userinfo가 있음';
  if (u.port) return '포트가 있음';
  if (!hostAllowed(u.hostname, domains)) return `호스트 ${u.hostname}가 manifest.domains 밖`;
  return null;
}

/** 정확 일치, `*.x.y`는 하위 도메인만(x.y 자체는 아님). */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d));
}

export function nameTemplateProblem(t: string): string | null {
  if (!/^([A-Za-z0-9_/-]|\{(docType|yyyy|MM|dd|yyyyMMdd|shortId)\})+\.pdf$/.test(t)) return '허용 밖 토큰';
  if (t.startsWith('/') || t.includes('//') || t.split('/').some((seg) => seg === '' || seg === '.pdf')) return '경로 형식';
  return null;
}

function checkRefs(ir: PlaybookIR, cfg: Cfg, steps: Step[], irreversible: Set<string>, bad: (rule: string, message: string, step?: string, target?: string) => void): void {
  const { info } = cfg;
  const domData = (a: string, b: string) => cfg.domData.get(b)?.has(a) ?? false;
  const optional = (name: string) => {
    const d = ir.inputs[name];
    return !!d && d.required !== true && d.default === undefined;
  };
  const varDefs = new Map<string, string[]>();
  const def = (name: string, id: string) => varDefs.set(name, [...(varDefs.get(name) ?? []), id]);
  for (const s of steps) {
    if (s.type === 'extract' || s.type === 'capture') def(s.name, s.id);
    if (s.type === 'verify' && s.lookup.bind?.approvalNo) def(s.lookup.bind.approvalNo, s.id);
  }
  const branchesFor = (name: string) =>
    steps.filter((s): s is StepOf<'branch'> => {
      if (s.type !== 'branch') return false;
      let hit = false;
      walkCond(s.on, (x) => 'inputPresent' in x && x.inputPresent === name && (hit = true));
      return hit;
    });
  const use = (ref: string, at: string, ctx: 'fill' | 'irreversible' | 'other') => {
    if (!ref.startsWith('$')) return;
    const scope = /^\$([a-z]+)\./.exec(ref)?.[1];
    if (scope === 'inputs') {
      const n = refHead(ref, 'inputs')!;
      if (!ir.inputs[n]) return bad('V-15', `$inputs.${n}가 선언되지 않음`, at);
      if (optional(n)) {
        const guarded = branchesFor(n).some((b) => domData(b.id, at));
        const s = info.get(at)?.step;
        if (ctx === 'fill' && !guarded && !(s?.type === 'fill' && s.ifAbsent)) bad('V-15', `선택 입력 ${n}을 쓰는 fill에 ifAbsent나 branch{inputPresent}가 없음`, at);
        if (ctx === 'irreversible' && !guarded) bad('V-15', `선택 입력 ${n}을 쓰는 비가역 스텝 앞에 branch{inputPresent}가 없음`, at);
      }
    } else if (scope === 'vars') {
      const n = refHead(ref, 'vars')!;
      if (!(varDefs.get(n) ?? []).some((d) => d !== at && domData(d, at))) bad('V-15', `$vars.${n}를 정의하는 스텝이 지배하지 않음`, at);
    } else if (scope === 'human') {
      const n = refHead(ref, 'human')!;
      const h = info.get(n)?.step;
      if (h?.type !== 'human') bad('V-15', `$human.${n}가 human 스텝이 아님`, at);
      else if (h.kind === 'secret') bad('V-20', `비밀 사람 입력 $human.${n}는 엔진에 오지 않음`, at);
      else if (!domData(n, at)) bad('V-15', `$human.${n}가 사용 지점을 지배하지 않음`, at);
    } else if (scope === 'readback') {
      const f = refHead(ref, 'readback')!;
      const ok = steps.some((s) => s.type === 'readback' && s.fields.includes(f) && domData(s.id, at));
      if (!ok) bad('V-15', `$readback.${f}를 읽는 readback이 지배하지 않음`, at);
    }
  };
  for (const s of steps) {
    const irr = irreversible.has(s.id) ? 'irreversible' : 'other';
    if (s.type === 'fill') use(s.value, s.id, 'fill');
    if (s.type === 'select') use(s.option, s.id, 'fill');
    if (s.type === 'secret_fill' && s.rowFrom) use(s.rowFrom, s.id, 'other');
    if (s.type === 'send_email') {
      use(s.to, s.id, irr);
      if (s.attach) use(s.attach, s.id, irr);
    }
    if (s.type === 'verify') for (const r of Object.values(s.lookup.match)) use(r, s.id, 'other');
    for (const c of stepConds(s))
      walkCond(c, (x) => {
        if ('readbackEquals' in x) {
          use(`$readback.${x.readbackEquals.fieldKey}`, s.id, 'other');
          use(x.readbackEquals.ref, s.id, 'other');
        }
        // sumEquals는 readback 값만 쓴다(D02 §8 s19d): parts·total 모두 그 앞 readback이 지배해야 한다.
        if ('sumEquals' in x) for (const f of [...x.sumEquals.parts, x.sumEquals.total]) use(`$readback.${f}`, s.id, 'other');
        if ('readbackEmpty' in x) use(`$readback.${x.readbackEmpty}`, s.id, 'other');
        if ('inputPresent' in x && !ir.inputs[x.inputPresent]) bad('V-15', `inputPresent ${x.inputPresent}가 선언되지 않음`, s.id);
      });
  }
  for (const c of [...(ir.preconditions ?? []), ...ir.postconditions])
    walkCond(c, (x) => {
      if ('inputVerified' in x && !ir.inputs[x.inputVerified]) bad('V-15', `inputVerified ${x.inputVerified}가 선언되지 않음`);
      if ('varSet' in x && !varDefs.has(x.varSet)) bad('V-15', `varSet ${x.varSet}를 정의하는 스텝이 없음`);
    });
}

function checkLoops(cfg: Cfg, bad: (rule: string, message: string, step?: string) => void): void {
  const { info } = cfg;
  const counted: EdgeKind[] = ['fall', 'body', 'out', 'fail', 'resume'];
  const guardFree = (n: string) => {
    const s = info.get(n)?.step;
    return !(s && s.loopGuard);
  };
  const edge = (n: string, keep: (m: string) => boolean): string[] => {
    const out: string[] = [];
    for (const [m, k] of cfg.succ.get(n) ?? []) {
      if (!counted.includes(k) || !keep(m)) continue;
      // repeat 본문 끝 → 헤더는 repeat가 상한을 집행한다.
      if (k === 'fall' && info.get(m)?.step.type === 'repeat' && info.get(n)?.repeats.at(-1) === m) continue;
      // 자기 자신의 핸드오프 재개(H:n → n)는 사람 차례가 상한이다.
      if (n === hNode(m)) continue;
      out.push(m);
    }
    return out;
  };
  // 게이트를 지나는 순환은 매번 사람 승인이 상한이다. 게이트와 합성 노드 일부를 뺀다.
  const nodes = [...cfg.succ.keys()].filter((n) => info.get(n)?.step.type !== 'gate' && n !== END && n !== ABORT && n !== FALLOFF);
  const keepAll = (m: string) => nodes.includes(m);
  const keepUnguarded = (m: string) => nodes.includes(m) && guardFree(m);
  for (const c of sccs(nodes, (n) => edge(n, keepAll))) {
    const cyclic = c.length > 1 || edge(c[0]!, keepAll).includes(c[0]!);
    if (!cyclic) continue;
    // 고리 하나하나에 loopGuard가 있는지: 가드 있는 노드를 빼고도 남는 순환이 있으면 위반.
    const sub = c.filter(guardFree);
    for (const r of sccs(sub, (n) => edge(n, (m) => sub.includes(m) && keepUnguarded(m)))) {
      if (r.length > 1 || edge(r[0]!, (m) => sub.includes(m)).includes(r[0]!)) bad('V-18', `repeat 밖 순환(${r.filter((n) => !isSynthetic(n)).sort().join(',')})에 loopGuard가 없음`, r.find((n) => !isSynthetic(n)));
    }
  }
}

/** V-22: 조회 하위 패키지(kind: lookup) 자체의 제한. */
export function lookupViolations(pkg: PackageFiles, cfg = buildCfg(pkg.playbook)): Violation[] {
  const v: Violation[] = [];
  const { manifest, playbook: ir, selectors: sel } = pkg;
  if (manifest.kind !== 'lookup') v.push({ rule: 'V-22', message: '조회 패키지의 kind가 lookup이 아님' });
  if (manifest.effects.length || ir.effects.length) v.push({ rule: 'V-22', message: '조회 패키지에 effects가 있음' });
  const allowed = new Set(['goto', 'wait', 'assert', 'extract', 'select', 'fill', 'click', 'end']);
  for (const { step: s } of cfg.info.values()) {
    if (!allowed.has(s.type)) v.push({ rule: 'V-22', step: s.id, message: `조회 패키지에 ${s.type}` });
    if (s.onFail?.then === 'recover' || ir.recovery?.default?.then === 'recover') v.push({ rule: 'V-22', step: s.id, message: '조회 패키지의 onFail: recover' });
    for (const t of stepTargets(s)) if (sel.entries[t.ref]?.commits) v.push({ rule: 'V-22', step: s.id, target: t.ref, message: '조회 패키지가 commits:true 타깃을 참조' });
    if (s.type === 'click' && !sel.entries[s.target]?.navigationOnly) v.push({ rule: 'V-22', step: s.id, target: s.target, message: '조회 패키지 click은 navigationOnly 항목만' });
    if (s.type === 'fill') {
      const role = sel.entries[s.target]?.role;
      if (role !== 'searchbox' && role !== 'combobox') v.push({ rule: 'V-22', step: s.id, target: s.target, message: '조회 패키지 fill은 searchbox·combobox만' });
    }
  }
  return v;
}

export type { SelectorEntry };
