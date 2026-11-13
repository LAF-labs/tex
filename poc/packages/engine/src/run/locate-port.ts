// AI 위치 찾기 모델 포트(core/locate.ts의 LocateModel): 게이트웨이 /v1/respond 툴셋 selector_repair(D04 §4) 한 번(도구 왕복 포함 최대 3턴).
// - 모델에는 마스킹된 글만 간다(D04 C-10, ③): 스텝 의도(역할·이름 규칙·필드 키)와 같은 역할 요소 목록(번호·접근성 이름·DOM id)을 Redactor로 가린다.
//   입력값은 목록에 없다(core/locate.ts). 모델이 낸 선택자 안의 토큰은 같은 Redactor 지도로 되돌린다.
// - 도구(get_a11y_subtree·find_candidates·propose_selectors)는 읽기 전용이다. 같은 목록으로만 답한다. 화면을 바꾸지 않는다.
// - 출력이 repaired가 아니거나 risk_flags에 비가역 대상·주입 의심이 있으면 받지 않는다(null). 받은 후보는 엔진이 다시 검사한다.
import type { RedactedReplayItem, RedactedText, RespondRequest, RespondResult, RunToken, ToolsetDef } from '@sax/model';
import { selectorRepair } from '@sax/model';
import type { Redactor } from '@sax/redaction';
import type { LocateCandidate, LocateModel, LocateRequest } from '../core/locate.ts';

export interface LocateResponder {
  respond(t: ToolsetDef, req: RespondRequest): Promise<RespondResult>;
}

const SCOPE = 'frame';

/**
 * 게이트웨이가 쓰는 selector_repair 정의와 같게(services/gateway/src/service.ts gatewayToolsets): scopeId는 열거가 아니라 형식 제한이다.
 * 어댑터는 응답 toolsetDigest를 이 정의의 해시와 대조하므로(C-24) 열거 정의로 부르면 늘 toolset_digest_mismatch다.
 * 도구 답은 scopeId와 상관없이 같은 목록으로만 한다(toolAnswer).
 */
export function locateToolset(): ToolsetDef {
  const t = selectorRepair([SCOPE]);
  for (const tool of t.tools) {
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    if (props.scopeId) props.scopeId = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' };
  }
  return t;
}
const BLOCK_FLAGS = new Set(['target_is_irreversible_action', 'possible_injection_text']);

export interface GatewayLocateInput {
  responder: LocateResponder;
  redactor: Pick<Redactor, 'apply' | 'map'>;
  runToken: () => Promise<RunToken>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

export class GatewayLocateModel implements LocateModel {
  private readonly i: GatewayLocateInput;

  constructor(i: GatewayLocateInput) {
    this.i = i;
  }

  private mask(text: string): RedactedText {
    return this.i.redactor.apply(text, { frame: 'none' }).redacted;
  }

  /** 마스킹한 글 안의 토큰을 원래 글로(모델이 낸 선택자). 모르는 토큰이 남으면 null. */
  private unmask(v: string): string | null {
    const out = v.replace(/\[[A-Z]+_\d+\]/g, (t) => this.i.redactor.map.valueOf(t) ?? t);
    return /\[[A-Z]+_\d+\]/.test(out) ? null : out;
  }

  async propose(req: LocateRequest): Promise<LocateCandidate[] | null> {
    const line = (x: LocateRequest['listing'][number]) => `${x.n}. ${req.role} "${x.name}"${x.id ? ` #${x.id}` : ''}`;
    const listing = req.listing.map(line).join('\n');
    const head = [
      '[AI 위치 찾기] 사전 선택자로 찾지 못한 요소를 같은 화면 프레임에서 고른다.',
      `step ${req.stepId} · purpose ${req.purpose} · role ${req.role} · namePattern(RE2) ${req.namePattern} · target ${req.describe}`,
      req.rejected.length ? `이미 써 보고 맞지 않은 선택자: ${req.rejected.join(', ')}` : '',
      '같은 역할 요소 목록(번호. 역할 "접근성 이름" #DOM id). 입력값은 없다.',
    ].filter(Boolean).join('\n');
    const tail = '가장 맞는 요소 하나를 candidates 맨 앞에 낸다. id가 있으면 kind css, value "#id". 없으면 kind role, value 역할, name 접근성 이름. 확신이 없으면 not_found.';
    let message: RedactedText;
    let listingMasked: RedactedText;
    try {
      message = this.mask(`${head}\n${listing}\n${tail}`);
      listingMasked = this.mask(listing);
    } catch {
      this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'redaction' });
      return null;
    }
    const t = locateToolset();
    const replay: RedactedReplayItem[] = [];
    let token: RunToken;
    try {
      token = await this.i.runToken();
    } catch {
      this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'run_token' });
      return null;
    }
    for (let turn = 0; turn < t.maxTurns; turn++) {
      let r: RespondResult;
      try {
        r = await this.i.responder.respond(t, { toolset: 'selector_repair', messages: [{ role: 'user', content: [{ type: 'input_text', text: message }] }], replay, runToken: token });
      } catch {
        this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'respond' });
        return null;
      }
      if (r.status !== 'completed') {
        this.i.journal('locate.unavailable', { stepId: req.stepId, cause: r.reason ?? r.status });
        return null;
      }
      if (r.toolCalls.length) {
        replay.push(...r.replay);
        for (const c of r.toolCalls) replay.push({ kind: 'function_call_output', callId: c.callId, output: this.toolAnswer(c.name, c.arguments, req, listingMasked) });
        continue;
      }
      return this.accept(req, r.output);
    }
    this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'turn_limit' });
    return null;
  }

  /** 읽기 전용 도구 답(같은 목록에서만). */
  private toolAnswer(name: string, args: unknown, req: LocateRequest, listingMasked: RedactedText): RedactedText {
    const a = (args ?? {}) as { nameContains?: string; role?: string };
    if (name === 'find_candidates') {
      const hits = req.listing.filter((x) => (a.role ?? req.role) === req.role && x.name.includes(String(a.nameContains ?? '')));
      return this.mask(hits.map((x) => `${x.n}. ${req.role} "${x.name}"${x.id ? ` #${x.id}` : ''}`).join('\n') || '(없음)');
    }
    if (name === 'propose_selectors') return this.mask('제안은 엔진이 최종 출력에서 검사한다. 최종 출력 candidates에 넣어라.');
    return listingMasked;
  }

  private accept(req: LocateRequest, output: unknown): LocateCandidate[] | null {
    const o = output as { outcome?: string; risk_flags?: string[]; candidates?: Array<{ kind: string; value: string; name: string }> } | undefined;
    const flags = o?.risk_flags ?? [];
    this.i.journal('locate.answer', { stepId: req.stepId, outcome: o?.outcome ?? 'none', flags: flags.join(',') });
    if (o?.outcome !== 'repaired' || flags.some((f) => BLOCK_FLAGS.has(f))) return null;
    const out: LocateCandidate[] = [];
    for (const c of o.candidates ?? []) {
      if (c.kind !== 'css' && c.kind !== 'role' && c.kind !== 'label') continue;
      const value = this.unmask(c.value);
      const name = this.unmask(c.name ?? '');
      if (value === null || name === null) continue;
      out.push({ kind: c.kind, value, name });
    }
    return out.length ? out : null;
  }
}
