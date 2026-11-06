// Playwright aria 스냅숏(YAML 모양) → 마스킹 입력 트리(A11yNode, D06 §3)(M2-2 B). L0 관측은 이 트리에서 만든다(run/decide.ts).
// - 스냅숏은 접근성 트리에서 숨김 요소가 이미 빠진 것이다. 레이아웃(화면 밖·투명·전경=배경)은 알 수 없다(못 한 것: DOMSnapshot).
// - 입력 역할(textbox·combobox·searchbox·spinbutton)의 인라인 값은 value로만 둔다. renderTree가 버리고 L0 관측에도 넣지 않는다.
// - 비밀 칸(셀렉터 사전 secretKind·password 항목의 이름과 맞는 입력)은 secret으로 표시해 값은 물론 길이도 남기지 않는다(V-20 런타임 가드).
// - 속성 줄(`- /url: …`)은 버린다. 문법이 틀린 줄은 건너뛰지 않고 던진다(fail-closed, 호출 측은 portal.unobservable).
import type { A11yNode } from '@sax/redaction';

const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);
const KEY_RE = /^([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)$/;

export class AriaParseError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`aria_parse:${line}`);
    this.line = line;
  }
}

/** YAML 따옴표 한 겹 벗기기(Playwright가 특수 문자 있는 줄을 '…'·"…"로 감싼다). */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"') && !/^"[^"]*"\s/.test(s)) return JSON.parse(s) as string;
  return s;
}

/** `key: inline` 나누기. key 안 따옴표 이름 속의 ':'는 건너뛴다. */
function splitItem(item: string): { key: string; inline: string | null; open: boolean } {
  let inQ = false;
  for (let i = 0; i < item.length; i++) {
    const c = item[i];
    if (c === '\\' && inQ) {
      i++;
      continue;
    }
    if (c === '"') inQ = !inQ;
    if (c === ':' && !inQ && (i === item.length - 1 || item[i + 1] === ' ')) {
      const rest = item.slice(i + 1).trim();
      return { key: item.slice(0, i).trim(), inline: rest ? unquote(rest) : null, open: !rest };
    }
  }
  return { key: item.trim(), inline: null, open: false };
}

function states(attrs: string): string[] {
  const out: string[] = [];
  for (const m of attrs.matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) {
    const k = m[1]!.trim();
    const v = m[2]?.trim();
    if (k === 'level' && v) out.push(`level${v}`);
    else if (k === 'checked' && v === 'mixed') out.push('mixed');
    else if (k === 'checked' && v === 'false') out.push('unchecked');
    else if (v === undefined || v === 'true') out.push(k);
  }
  return out;
}

/**
 * 스냅숏 → 루트 노드. root는 스냅숏을 뜬 요소(문서면 'document').
 * isSecret: 이 이름의 입력은 비밀 칸으로 표시한다(셀렉터 사전 secretKind·password 항목의 namePattern).
 */
export function ariaToTree(snapshot: string, o: { rootRole?: string; isSecret?: (name: string) => boolean } = {}): A11yNode {
  const root: A11yNode = { role: o.rootRole ?? 'document', children: [] };
  const stack: Array<{ indent: number; node: A11yNode }> = [{ indent: -1, node: root }];
  const lines = snapshot.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (!m) throw new AriaParseError(i + 1);
    const indent = m[1]!.length;
    // 특수 문자가 든 항목은 Playwright가 통째로 '…'로 감싼다(`- 'text: 문의: 고객센터'`).
    const body = m[2]!.startsWith("'") && m[2]!.endsWith("'") ? unquote(m[2]!) : m[2]!;
    if (body.startsWith('/')) continue; // 속성 줄(/url·/placeholder)
    const { key: rawKey, inline } = splitItem(body);
    const key = unquote(rawKey);
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.node;
    let node: A11yNode;
    if (key === 'text') node = { role: 'text', name: inline ?? '' };
    else {
      const k = KEY_RE.exec(key);
      if (!k) {
        // 이름 없는 텍스트 노드: `- 본문 문장`
        if (!/[:[\]"]/.test(key)) node = { role: 'text', name: key };
        else throw new AriaParseError(i + 1);
      } else {
        const role = k[1]!;
        const name = k[2] === undefined ? undefined : (JSON.parse(`"${k[2]}"`) as string);
        node = { role, ...(name !== undefined ? { name } : {}) };
        const st = states(k[3] ?? '');
        if (st.length) node.states = st;
        if (inline !== null) {
          if (INPUT_ROLES.has(role)) node.value = inline;
          else if (name === undefined) node.name = inline;
          else node.children = [{ role: 'text', name: inline }];
        }
        if (INPUT_ROLES.has(role) && name !== undefined && o.isSecret?.(name)) {
          node.secret = true;
          delete node.value;
        }
      }
    }
    (parent.children ??= []).push(node);
    stack.push({ indent, node });
  }
  return root;
}
