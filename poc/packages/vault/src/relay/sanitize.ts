// 응답 정리(D05 §3.4). 엔진으로 가는 CDP 메시지에서 비밀 평문이 실릴 수 있는 필드를 지운다.
// 입력: 엔진행 메시지(이미 파싱됨), 비밀 노드 집합. 메시지를 제자리에서 고친다.

type Json = Record<string, unknown>;

export interface SecretNodes {
  /** 금고가 입력한 노드, human:secret 대상 노드, type=password 노드의 backendNodeId. */
  backendIds: ReadonlySet<number>;
}

const isPasswordAttrs = (attrs: unknown): boolean => {
  if (!Array.isArray(attrs)) return false;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (String(attrs[i]).toLowerCase() === 'type' && String(attrs[i + 1]).toLowerCase() === 'password') return true;
  }
  return false;
};

/** 요청 바디 제거(오염 범위 요청). */
export function stripRequestBody(request: Json | undefined): boolean {
  if (!request) return false;
  const had = 'postData' in request || 'postDataEntries' in request || request.hasPostData === true;
  delete request.postData;
  delete request.postDataEntries;
  delete request.hasPostData;
  return had;
}

const AUTH_HEADERS = new Set(['cookie', 'set-cookie', 'authorization']);

/**
 * 쿠키·인증 헤더 제거(N-51). 객체({이름: 값}) 또는 배열([{name, value}]) 모양을 제자리에서 고친다. 지운 수를 돌려준다.
 * 엔진 신호는 상태·URL만 쓰므로 홈택스 세션 쿠키를 엔진에 줄 이유가 없다.
 */
export function stripAuthHeaders(h: Json | Json[] | undefined): number {
  if (!h || typeof h !== 'object') return 0;
  let n = 0;
  if (Array.isArray(h)) {
    for (let i = h.length - 1; i >= 0; i--) {
      if (AUTH_HEADERS.has(String(h[i]?.name).toLowerCase())) {
        h.splice(i, 1);
        n++;
      }
    }
    return n;
  }
  for (const k of Object.keys(h)) {
    if (AUTH_HEADERS.has(k.toLowerCase())) {
      delete h[k];
      n++;
    }
  }
  return n;
}

/** 요청·응답 객체의 헤더 필드 정리(원문 headersText는 통째로 지운다). */
export function stripMessageHeaders(m: Json | undefined): number {
  if (!m || typeof m !== 'object') return 0;
  let n = stripAuthHeaders(m.headers as Json) + stripAuthHeaders(m.requestHeaders as Json);
  for (const k of ['headersText', 'requestHeadersText', 'associatedCookies', 'blockedCookies', 'exemptedCookies']) {
    if (k in m) {
      delete m[k];
      n++;
    }
  }
  return n;
}

/** DOM.Node 트리(describeNode·getDocument·setChildNodes 등)의 비밀 노드 value 속성·nodeValue 제거. */
export function scrubDomNode(node: Json | undefined, secrets: SecretNodes): number {
  if (!node || typeof node !== 'object') return 0;
  let n = 0;
  const isSecret = secrets.backendIds.has(Number(node.backendNodeId)) || (String(node.nodeName).toUpperCase() === 'INPUT' && isPasswordAttrs(node.attributes));
  if (isSecret) {
    const attrs = node.attributes;
    if (Array.isArray(attrs)) {
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (String(attrs[i]).toLowerCase() === 'value') {
          attrs[i + 1] = '';
          n++;
        }
      }
    }
    if (typeof node.value === 'string') {
      node.value = '';
      n++;
    }
  }
  for (const key of ['children', 'shadowRoots', 'pseudoElements', 'distributedNodes']) {
    const arr = node[key];
    if (Array.isArray(arr)) for (const c of arr) n += scrubDomNode(c as Json, secrets);
  }
  for (const key of ['contentDocument', 'templateContent', 'importedDocument']) n += scrubDomNode(node[key] as Json | undefined, secrets);
  return n;
}

const MASK_ONLY = /^[\u2022\u25CF*]+$/;

/**
 * Accessibility AXNode 배열 정리. S6d(Chrome 156): password 칸 자체는 value를 같은 길이의 •로 싣고,
 * 그 안쪽 StaticText 자식이 name에 같은 •를 싣는다(길이 노출). 비밀 노드와 그 자손의 value·name을 지우고,
 * 부분 트리 응답(부모가 빠진 경우)에 대비해 마스킹 문자로만 된 값도 지운다.
 */
export function scrubAxNodes(nodes: unknown, secrets: SecretNodes): number {
  if (!Array.isArray(nodes)) return 0;
  const byId = new Map<string, Json>();
  for (const raw of nodes) byId.set(String((raw as Json).nodeId), raw as Json);
  const targets = new Set<Json>();
  const addTree = (n: Json | undefined) => {
    if (!n || targets.has(n)) return;
    targets.add(n);
    for (const c of (n.childIds as string[] | undefined) ?? []) addTree(byId.get(String(c)));
  };
  for (const raw of nodes) if (secrets.backendIds.has(Number((raw as Json).backendDOMNodeId))) addTree(raw as Json);
  for (const raw of nodes) {
    const node = raw as Json;
    for (const k of ['name', 'value']) {
      const v = (node[k] as Json | undefined)?.value;
      if (typeof v === 'string' && v.length > 0 && MASK_ONLY.test(v)) targets.add(node);
    }
  }
  let n = 0;
  for (const node of targets) {
    if ('value' in node) {
      delete node.value;
      n++;
    }
    const name = node.name as Json | undefined;
    if (name && typeof name.value === 'string' && name.value !== '' && (MASK_ONLY.test(name.value) || !secrets.backendIds.has(Number(node.backendDOMNodeId)))) {
      // 자손 텍스트·마스킹 이름만 지운다(비밀 칸 자신의 라벨 이름은 남긴다).
      name.value = '';
      delete name.sources;
      n++;
    }
    if (Array.isArray(node.properties)) {
      const props = node.properties as Json[];
      node.properties = props.filter((p) => !['valuetext', 'value'].includes(String(p.name)));
      n += props.length - (node.properties as Json[]).length;
    }
  }
  return n;
}

/**
 * DOMSnapshot.captureSnapshot 결과 정리. 문서별 nodes.inputValue·textValue(RareStringData)에서
 * 비밀 노드 항목을 빼고, 문자열 표의 해당 값을 비운다.
 */
export function scrubDomSnapshot(result: Json, secrets: SecretNodes): number {
  const strings = result.strings as string[] | undefined;
  const docs = result.documents as Json[] | undefined;
  if (!Array.isArray(strings) || !Array.isArray(docs)) return 0;
  let n = 0;
  for (const doc of docs) {
    const nodes = doc.nodes as Json | undefined;
    if (!nodes) continue;
    const backend = (nodes.backendNodeId as number[] | undefined) ?? [];
    const attrs = (nodes.attributes as number[][] | undefined) ?? [];
    const secretIdx = new Set<number>();
    backend.forEach((b, i) => {
      if (secrets.backendIds.has(b)) secretIdx.add(i);
    });
    attrs.forEach((pairs, i) => {
      for (let k = 0; k + 1 < pairs.length; k += 2) {
        if (strings[pairs[k]!]?.toLowerCase() === 'type' && strings[pairs[k + 1]!]?.toLowerCase() === 'password') secretIdx.add(i);
      }
    });
    for (const key of ['inputValue', 'textValue']) {
      const rare = nodes[key] as { index: number[]; value: number[] } | undefined;
      if (!rare?.index) continue;
      const keepIdx: number[] = [];
      const keepVal: number[] = [];
      rare.index.forEach((nodeIndex, j) => {
        if (secretIdx.has(nodeIndex)) {
          const sIdx = rare.value[j]!;
          if (strings[sIdx]) strings[sIdx] = '';
          n++;
        } else {
          keepIdx.push(nodeIndex);
          keepVal.push(rare.value[j]!);
        }
      });
      rare.index = keepIdx;
      rare.value = keepVal;
    }
  }
  return n;
}

/**
 * 알려진 비밀 값(금고가 입력했거나 활성 창 종료 시 읽은 값)의 직렬화 변형을 엔진행 문자열에서 지운다.
 * 짧은 값(보안카드 2~4자리 등)은 정상 텍스트를 깨뜨리므로 대상에서 뺀다(구조 정리에 맡김).
 */
export const KNOWN_VALUE_MIN_LEN = 6;

export function knownValueVariants(secret: string): string[] {
  const v = new Set<string>();
  v.add(secret);
  v.add(JSON.stringify(secret).slice(1, -1));
  v.add(encodeURIComponent(secret));
  v.add(encodeURIComponent(secret).replace(/%20/g, '+'));
  const b64 = Buffer.from(secret, 'utf8').toString('base64').replace(/=+$/, '');
  if (b64.length >= 4) v.add(b64.slice(0, b64.length - (b64.length % 4)));
  return [...v].filter((s) => s.length >= KNOWN_VALUE_MIN_LEN);
}

export function scrubKnownValues(raw: string, variants: readonly string[]): { text: string; hits: number } {
  let text = raw;
  let hits = 0;
  for (const v of variants) {
    if (!text.includes(v)) continue;
    const parts = text.split(v);
    hits += parts.length - 1;
    text = parts.join('[vault-redacted]');
  }
  return { text, hits };
}
