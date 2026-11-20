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

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"') && !/^"[^"]*"\s/.test(s)) return JSON.parse(s) as string;
  return s;
}

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
    const body = m[2]!.startsWith("'") && m[2]!.endsWith("'") ? unquote(m[2]!) : m[2]!;
    if (body.startsWith('/')) continue;
    const { key: rawKey, inline } = splitItem(body);
    const key = unquote(rawKey);
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.node;
    let node: A11yNode;
    if (key === 'text') node = { role: 'text', name: inline ?? '' };
    else {
      const k = KEY_RE.exec(key);
      if (!k) {
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

/** aria 스냅숏 첫 줄 `- role "name": value`의 값. combobox는 [selected] 항목 이름. */
export function ariaValue(snapshot: string, role: string): string {
  const unq = (v: string) => {
    const t = v.trim();
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    return t;
  };
  const lines = snapshot.split('\n');
  if (role === 'radiogroup') {
    const sel = lines.map((l) => /^\s*- radio "((?:[^"\\]|\\.)*)".*\[checked\]/.exec(l)).find(Boolean);
    return sel ? (JSON.parse(`"${sel[1]}"`) as string) : '';
  }
  if (role === 'combobox') {
    const sel = lines.map((l) => /^\s*- option "((?:[^"\\]|\\.)*)".*\[selected\]/.exec(l)).find(Boolean);
    return sel ? (JSON.parse(`"${sel[1]}"`) as string) : '';
  }
  const m = /^- [a-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*(?::(.*))?$/.exec(lines[0] ?? '');
  if (m?.[1] === undefined) return '';
  if (m[1].trim() !== '') return unq(m[1]);
  const child = lines.slice(1).map((l) => /^ {2}- text: (.*)$/.exec(l)).find(Boolean);
  return child ? unq(child[1]!) : '';
}
