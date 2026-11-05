// D06 §3 접근성 트리 추출과 절단. 입력은 금고 중계 필터를 지난 스냅샷을 엔진이 이 모양으로 옮긴 것(D05 §3.4)이고,
// 이 모듈은 Playwright·CDP에 의존하지 않는다(엔진이 CDP Accessibility·DOMSnapshot 결과를 A11yNode로 바꿔 넘긴다).
// 규칙: scope 서브트리 → 숨김·장식·스크립트·보이지 않는 텍스트 제거 → 표는 머리글 + 첫 3행 + 행 수 → 입력값 제거 →
// 이름 출처 표식·이스케이프·200자 → 역할·상태 허용 목록 → 크기 상한(깊은 곳부터 접기). 실패하면 던진다(fail-closed, D06 §4).

export type NameSource = 'contents' | 'aria' | 'alt' | 'title' | 'label' | 'placeholder' | 'related';

export interface A11yLayout {
  /** 뷰포트 밖 절대 위치 */
  offscreen?: boolean;
  width?: number;
  height?: number;
  opacity?: number;
  /** 전경색 = 배경색 */
  fgEqualsBg?: boolean;
  /** clip·clip-path로 숨김 */
  clipped?: boolean;
}

export interface A11yNode {
  role: string;
  name?: string;
  /** CDP name.sources에서 이긴 출처. aria·alt는 `(aria)` 표식, title은 제거한다(D06 §3, D-25). */
  nameSource?: NameSource;
  /** 입력 요소의 값. 기본 제거한다(D06 §4 입력값 기본 거부). */
  value?: string;
  states?: string[];
  /** CDP ignored / aria-hidden / display:none */
  hidden?: boolean;
  layout?: A11yLayout;
  /** type=password·secretSlot·최근 타이피스트 대상: 값은 물론 길이도 남기지 않는다. */
  secret?: boolean;
  /** 스텝 scope가 가리키는 노드 ID(엔진이 붙인다) */
  scopeId?: string;
  children?: A11yNode[];
}

/** 렌더 결과 한 줄. group은 같은 부모 아래 형제 묶음 번호(인접 노드 결합 탐지, D06 §4 ①). */
export interface A11yLine {
  depth: number;
  role: string;
  name: string;
  aria: boolean;
  states: string[];
  group: number;
  /** 접힌 노드 요약 줄(…(+N nodes)) */
  fold?: number;
  /** 표 행 수 요약 줄 */
  rows?: number;
}

export interface RenderOptions {
  /** scope 노드 ID. 없거나 못 찾으면 main·dialog 역할 우선, 그다음 루트. */
  scopeId?: string;
  /** UTF-8 바이트 상한(L1 6KB, L2 8KB) */
  maxBytes: number;
  /** 표 데이터 행 몇 개를 남길지(기본 3) */
  tableRows?: number;
}

export interface RenderStats {
  nodesIn: number;
  nodesOut: number;
  removedHidden: number;
  removedInvisible: number;
  removedTitle: number;
  droppedValues: number;
  folded: number;
  tableRowsCut: number;
  scope: 'scopeId' | 'landmark' | 'root';
}

export class RedactionError extends Error {
  readonly code: 'scope_not_found' | 'tree_invalid' | 'size_unreachable' | 'image_disabled_phase1' | 'image_invalid';
  constructor(code: RedactionError['code']) {
    super(code);
    this.code = code;
  }
}

export const NAME_MAX = 200;

/** 역할 허용 목록. 밖의 역할은 generic으로 쓴다(D-25: 역할·상태는 허용 목록 값만). */
export const ROLE_ALLOW = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'caption', 'cell', 'checkbox', 'columnheader', 'combobox', 'complementary',
  'contentinfo', 'definition', 'dialog', 'document', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox',
  'listitem', 'main', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'note', 'option', 'paragraph', 'progressbar',
  'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'search', 'searchbox', 'separator', 'spinbutton', 'status', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'text', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem', 'StaticText', 'RootWebArea', 'WebArea',
]);
export const STATE_ALLOW = new Set(['required', 'invalid', 'disabled', 'checked', 'unchecked', 'mixed', 'selected', 'expanded', 'collapsed', 'pressed', 'readonly', 'focused', 'modal', 'busy', 'level1', 'level2', 'level3', 'level4', 'level5', 'level6']);
const INPUT_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'searchbox']);
const DROP_ROLES = new Set(['script', 'style', 'noscript', 'template', 'meta', 'LineBreak', 'InlineTextBox']);
const DECOR_ROLES = new Set(['presentation', 'none']);
const LANDMARKS = ['dialog', 'alertdialog', 'main'];
const TABLE_ROLES = new Set(['table', 'grid', 'treegrid']);

function invisible(l: A11yLayout | undefined): boolean {
  if (!l) return false;
  return !!l.offscreen || l.width === 0 || l.height === 0 || l.opacity === 0 || !!l.fgEqualsBg || !!l.clipped;
}

function findScope(root: A11yNode, id: string): A11yNode | null {
  if (root.scopeId === id) return root;
  for (const c of root.children ?? []) {
    const f = findScope(c, id);
    if (f) return f;
  }
  return null;
}

function findLandmark(root: A11yNode): A11yNode | null {
  // 열린 대화상자가 있으면 그것이 우선(모달이 주된 화면), 그다음 main.
  for (const role of LANDMARKS) {
    const stack = [root];
    while (stack.length) {
      const n = stack.shift()!;
      if (n.role === role && !n.hidden && !invisible(n.layout)) return n;
      stack.push(...(n.children ?? []));
    }
  }
  return null;
}

function count(n: A11yNode): number {
  return 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
}

/** 노드 이름 이스케이프(D-25): 공백 정리 후 200자로 자르고 JSON 문자열로. 줄바꿈·따옴표·(state) 위조가 구조로 읽히지 않는다. */
export function escapeName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  const cut = [...flat].slice(0, NAME_MAX).join('');
  return JSON.stringify(cut);
}

export function lineText(l: A11yLine): string {
  const pad = '  '.repeat(l.depth);
  if (l.fold !== undefined) return `${pad}…(+${l.fold} nodes)`;
  if (l.rows !== undefined) return `${pad}…(rows: ${l.rows})`;
  const name = l.name ? ` ${escapeName(l.name)}${l.aria ? '(aria)' : ''}` : '';
  const st = l.states.length ? `(${l.states.join(', ')})` : '';
  return `${pad}${l.role}${name}${st}`;
}

const bytes = (lines: A11yLine[]) => lines.reduce((a, l) => a + Buffer.byteLength(lineText(l), 'utf8') + 1, 0);

/**
 * 트리를 줄 목록으로 렌더한다. 이름 안의 식별자 치환은 하지 않는다(apply.ts의 Redactor.applyTree가 줄 단위로 한다).
 * 반환 줄은 크기 상한 안이다. 접어도 상한을 못 맞추면 RedactionError('size_unreachable').
 */
export function renderTree(root: A11yNode, opts: RenderOptions): { lines: A11yLine[]; stats: RenderStats } {
  if (!root || typeof root !== 'object' || typeof root.role !== 'string') throw new RedactionError('tree_invalid');
  const stats: RenderStats = { nodesIn: count(root), nodesOut: 0, removedHidden: 0, removedInvisible: 0, removedTitle: 0, droppedValues: 0, folded: 0, tableRowsCut: 0, scope: 'root' };
  let scope: A11yNode = root;
  if (opts.scopeId) {
    const s = findScope(root, opts.scopeId);
    if (!s) throw new RedactionError('scope_not_found');
    scope = s;
    stats.scope = 'scopeId';
  } else {
    const l = findLandmark(root);
    if (l) {
      scope = l;
      stats.scope = 'landmark';
    }
  }
  const keepRows = opts.tableRows ?? 3;
  const lines: A11yLine[] = [];
  let groups = 0;

  const walk = (n: A11yNode, depth: number, group: number) => {
    if (n.hidden) {
      stats.removedHidden += count(n);
      return;
    }
    if (invisible(n.layout)) {
      stats.removedInvisible += count(n);
      return;
    }
    if (DROP_ROLES.has(n.role)) return;
    const kids = n.children ?? [];
    const decor = DECOR_ROLES.has(n.role);
    // 이름 없는 generic·장식 노드는 줄을 만들지 않고 자식을 같은 깊이·같은 묶음으로 편다.
    const flatten = decor || ((n.role === 'generic' || n.role === 'group') && !n.name);
    if (!flatten) {
      let name = n.name ?? '';
      if (n.nameSource === 'title') {
        if (name) stats.removedTitle++;
        name = '';
      }
      if (INPUT_ROLES.has(n.role) || n.secret) {
        if (n.value !== undefined && n.value !== '') stats.droppedValues++;
        // 입력 요소는 라벨(이름)·상태만. 값은 없다. 비밀 칸은 길이도 남기지 않는다.
      }
      const role = ROLE_ALLOW.has(n.role) ? n.role : 'generic';
      const states = (n.states ?? []).filter((s) => STATE_ALLOW.has(s));
      if (name || !(role === 'generic' || role === 'StaticText' || role === 'text')) {
        lines.push({ depth, role, name, aria: n.nameSource === 'aria' || n.nameSource === 'alt', states, group });
      }
    }
    const childDepth = flatten ? depth : depth + 1;
    const childGroup = flatten ? group : ++groups;
    if (TABLE_ROLES.has(n.role)) {
      // 머리글 행 + 첫 keepRows 데이터 행 + 행 수(D06 §3)
      const rows: A11yNode[] = [];
      const collect = (x: A11yNode) => {
        for (const c of x.children ?? []) {
          if (c.role === 'row') rows.push(c);
          else if (c.role === 'rowgroup' || c.role === 'generic') collect(c);
          else walk(c, childDepth, childGroup);
        }
      };
      collect(n);
      const isHeader = (r: A11yNode) => (r.children ?? []).some((c) => c.role === 'columnheader');
      const data = rows.filter((r) => !isHeader(r) && !r.hidden && !invisible(r.layout));
      for (const r of rows.filter(isHeader)) walk(r, childDepth, childGroup);
      for (const r of data.slice(0, keepRows)) walk(r, childDepth, childGroup);
      if (data.length > keepRows) {
        stats.tableRowsCut += data.length - keepRows;
        lines.push({ depth: childDepth, role: 'row', name: '', aria: false, states: [], group: childGroup, rows: data.length });
      }
      return;
    }
    for (const c of kids) walk(c, childDepth, childGroup);
  };
  walk(scope, 0, 0);

  // 크기 상한: 가장 깊은 줄부터 접어 부모 바로 아래 …(+N nodes) 한 줄로 바꾼다.
  let out = lines;
  while (bytes(out) > opts.maxBytes) {
    const maxDepth = Math.max(...out.map((l) => l.depth));
    if (maxDepth === 0) {
      // 루트 깊이만 남았는데도 크면 끝에서부터 잘라 요약한다.
      let cut = 0;
      while (out.length > 1 && bytes(out) > opts.maxBytes) {
        const last = out.pop()!;
        cut += last.fold ?? 1;
      }
      if (cut) out.push({ depth: 0, role: 'generic', name: '', aria: false, states: [], group: 0, fold: cut });
      if (bytes(out) > opts.maxBytes) throw new RedactionError('size_unreachable');
      stats.folded += cut;
      break;
    }
    const next: A11yLine[] = [];
    for (const l of out) {
      if (l.depth === maxDepth) {
        const prev = next[next.length - 1];
        const n = l.fold ?? 1;
        stats.folded += l.fold ? 0 : 1;
        if (prev && prev.fold !== undefined && prev.depth === maxDepth - 1 && prev.group === l.group) prev.fold += n;
        else next.push({ depth: maxDepth - 1, role: 'generic', name: '', aria: false, states: [], group: l.group, fold: n });
      } else next.push(l);
    }
    out = next;
  }
  stats.nodesOut = out.filter((l) => l.fold === undefined && l.rows === undefined).length;
  return { lines: out, stats };
}
