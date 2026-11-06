// 온보딩 O-03 공동인증서 목록(D05 §6 (1)~(3), ADR-014 결정 1, D17 §3). 금고 control `npki.list`(#93)가 열거만 하고,
// 공개 인증서(signCert.der) 해석은 docparse 샌드박스 `certInfo`(#95)가 한다. main은 결과를 스키마로 검증해 표시 행으로만 바꾼다.
// - 경로(dir·certFile)·주체 전체(subject)는 렌더러·로그·텔레메트리·모델로 보내지 않는다. 렌더러에는 id·소유자 이름·발급자·만료일만 간다.
// - 개인키 파일이 없는 인증서(hasKey=false)·만료된 인증서는 보이되 고를 수 없다.
// - 로그에는 개수만 남긴다(값 없음).
import type { CertInfo } from '@sax/docparse';
import type { NpkiCert } from './onboarding.ts';

export type VaultControl = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** der → 고정 4필드(샌드박스 certInfo, 스키마 검증 뒤). 못 읽으면 던진다. */
export type CertInfoReader = (der: Uint8Array) => Promise<CertInfo>;
export type NpkiLog = (name: string, data: Record<string, number>) => void;

/** 한 번에 보일 상한(금고도 상한이 있다, 그보다 많으면 앞에서부터). */
export const NPKI_SHOW_MAX = 50;
const DER_MAX = 8192;
const ID_RE = /^[0-9a-f]{16}$/;

interface Entry {
  id: string;
  ca: string;
  der: Uint8Array;
  hasKey: boolean;
}

/** 금고 응답에서 필요한 칸만 꺼낸다(dir·certFile은 꺼내지 않는다). 모양이 틀린 항목은 버린다. */
function entries(r: unknown): { ok: Entry[]; bad: number } {
  const certs = (r as { certs?: unknown } | null)?.certs;
  if (!Array.isArray(certs)) return { ok: [], bad: 0 };
  const ok: Entry[] = [];
  let bad = 0;
  const seen = new Set<string>();
  for (const c of certs as Array<Record<string, unknown>>) {
    const der = c?.certDer;
    if (
      !c || typeof c.id !== 'string' || !ID_RE.test(c.id) || seen.has(c.id) || typeof c.ca !== 'string' || typeof c.hasKey !== 'boolean' ||
      !(der instanceof Uint8Array) || der.length === 0 || der.length > DER_MAX
    ) {
      bad++;
      continue;
    }
    seen.add(c.id);
    ok.push({ id: c.id, ca: c.ca, der, hasKey: c.hasKey });
  }
  return { ok, bad };
}

/** RFC 4514 이름에서 첫 속성 값(가장 구체적인 RDN부터). 이스케이프(\, \+ \XX)를 푼다. 없으면 ''. */
export function rdnValue(name: string, type: string): string {
  let i = 0;
  while (i < name.length) {
    // 속성 하나: type=value (값 안의 이스케이프된 , + 는 구분자가 아니다)
    let j = i;
    let raw = '';
    while (j < name.length && name[j] !== ',' && name[j] !== '+') {
      if (name[j] === '\\' && j + 1 < name.length) {
        raw += name.slice(j, j + 2);
        j += 2;
      } else raw += name[j++];
    }
    const eq = raw.indexOf('=');
    if (eq > 0 && raw.slice(0, eq).trim().toUpperCase() === type) return unescapeRdn(raw.slice(eq + 1));
    i = j + 1;
  }
  return '';
}
function unescapeRdn(v: string): string {
  const bytes: number[] = [];
  const out: string[] = [];
  const flush = () => {
    if (bytes.length) out.push(Buffer.from(bytes.splice(0)).toString('utf8'));
  };
  for (let k = 0; k < v.length; k++) {
    if (v[k] === '\\' && /^[0-9a-fA-F]{2}$/.test(v.slice(k + 1, k + 3))) {
      bytes.push(parseInt(v.slice(k + 1, k + 3), 16));
      k += 2;
    } else if (v[k] === '\\' && k + 1 < v.length) {
      flush();
      out.push(v[++k]!);
    } else {
      flush();
      out.push(v[k]!);
    }
  }
  flush();
  return out.join('');
}

/** NPKI CN(`홍길동()0012345…`)에서 사람이 읽는 이름만. 뒤의 식별 번호는 보이지 않는다. */
export const certOwner = (subject: string): string => rdnValue(subject, 'CN').replace(/\(\)[0-9A-Za-z]*$/, '').trim().slice(0, 60);
/** 발급자 이름(issuer O=, 없으면 CA 폴더 이름). */
const certIssuer = (issuer: string, ca: string): string => (rdnValue(issuer, 'O') || ca).trim().slice(0, 40);

/**
 * 금고 열거 → 샌드박스 해석 → 표시 행. today(YYYY-MM-DD)보다 이전에 만료된 인증서는 고를 수 없다.
 * 금고가 실패하면 빈 목록(온보딩은 "찾지 못했어요"로 이어 간다).
 */
export async function listNpkiCerts(control: VaultControl, readInfo: CertInfoReader, opts: { today: string; log?: NpkiLog }): Promise<NpkiCert[]> {
  const r = await control('npki.list', {});
  const { ok, bad } = entries(r);
  const out: NpkiCert[] = [];
  let invalid = 0;
  for (const e of ok.slice(0, NPKI_SHOW_MAX)) {
    let info: CertInfo;
    try {
      info = await readInfo(e.der);
    } catch {
      invalid++;
      continue;
    }
    const owner = certOwner(info.subject);
    const expiresOn = info.notAfter.slice(0, 10);
    if (!owner || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
      invalid++;
      continue;
    }
    const why = !e.hasKey ? 'no_key' : expiresOn < opts.today ? 'expired' : undefined;
    out.push({ id: e.id, owner, usage: certIssuer(info.issuer, e.ca), expiresOn, usable: !why, ...(why ? { why } : {}) });
  }
  opts.log?.('main.npki_shown', { listed: ok.length + bad, shown: out.length, unusable: out.filter((c) => !c.usable).length, invalid: invalid + bad });
  return out;
}
