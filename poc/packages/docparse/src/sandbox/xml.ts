// xlsx 부분 XML(시트·공유 문자열·통합 문서·스타일)만 읽는 작은 토크나이저. DTD·엔티티 선언은 받지 않는다(XXE·억대 웃음 폭탄).
// 미리 정의된 다섯 엔티티와 숫자 참조만 푼다. 깊이 상한을 둔다.
import { SandboxError, SHEET_LIMITS } from './limits.ts';

export interface XmlOpen {
  type: 'open';
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}
export interface XmlClose {
  type: 'close';
  name: string;
}
export interface XmlText {
  type: 'text';
  text: string;
}
export type XmlToken = XmlOpen | XmlClose | XmlText;

const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

/** 로컬 이름(접두사 제거). xlsx는 x:·r: 같은 접두사를 붙이기도 한다. */
export const localName = (n: string) => n.slice(n.indexOf(':') + 1);

/** 토큰을 하나씩 낸다. 잘못된 XML이면 xml_invalid, DOCTYPE·ENTITY면 xml_doctype. */
export function* tokenize(xml: string): Generator<XmlToken> {
  let i = 0;
  let depth = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const t = xml.slice(i);
      if (t.trim()) yield { type: 'text', text: decodeEntities(t) };
      break;
    }
    if (lt > i) yield { type: 'text', text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) throw new SandboxError('xml_invalid');
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) throw new SandboxError('xml_invalid');
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw new SandboxError('xml_invalid');
      yield { type: 'text', text: xml.slice(lt + 9, e) };
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new SandboxError('xml_doctype'); // DOCTYPE·ENTITY·ELEMENT
    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) throw new SandboxError('xml_invalid');
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      depth--;
      if (depth < 0) throw new SandboxError('xml_invalid');
      yield { type: 'close', name: body.slice(1).trim() };
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = /^([A-Za-z_][\w:.-]*)/.exec(inner);
    if (!m) throw new SandboxError('xml_invalid');
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = m[1]!.length;
    for (let a = ATTR.exec(inner); a; a = ATTR.exec(inner)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
    if (!selfClosing) {
      depth++;
      if (depth > SHEET_LIMITS.maxXmlDepth) throw new SandboxError('xml_invalid');
    }
    yield { type: 'open', name: m[1]!, attrs, selfClosing };
  }
}

/** 따옴표 안의 '>'를 건너뛰며 태그 끝을 찾는다. */
function findTagEnd(xml: string, from: number): number {
  let q: string | null = null;
  for (let k = from; k < xml.length; k++) {
    const c = xml[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return k;
    else if (c === '<') return -1;
  }
  return -1;
}
