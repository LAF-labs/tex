import type { CertInfo } from '@sax/docparse';
import type { NpkiCert } from './onboarding.ts';

export type VaultControl = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type CertInfoReader = (der: Uint8Array) => Promise<CertInfo>;
type NpkiLog = (name: string, data: Record<string, number>) => void;

export const NPKI_SHOW_MAX = 50;
const DER_MAX = 8192;
const ID_RE = /^[0-9a-f]{16}$/;

interface Entry {
  id: string;
  ca: string;
  der: Uint8Array;
  hasKey: boolean;
}

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

export function rdnValue(name: string, type: string): string {
  let i = 0;
  while (i < name.length) {
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

export const certOwner = (subject: string): string => rdnValue(subject, 'CN').replace(/\(\)[0-9A-Za-z]*$/, '').trim().slice(0, 60);
export function certKind(subject: string): 'corp' | 'personal' | null {
  const ous = subject.split(/,(?=\s*[A-Za-z]+=)/).map((x) => x.trim()).filter((x) => /^OU=/i.test(x)).map((x) => x.slice(3));
  if (ous.some((v) => /corporat|법인|기업|사업자/i.test(v))) return 'corp';
  if (ous.some((v) => /personal|개인/i.test(v))) return 'personal';
  return null;
}

const certIssuer = (issuer: string, ca: string): string => (rdnValue(issuer, 'O') || ca).trim().slice(0, 40);

export async function listNpkiCerts(control: VaultControl, readInfo: CertInfoReader, opts: { today: string; log?: NpkiLog; names?: Map<string, string> }): Promise<NpkiCert[]> {
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
    opts.names?.set(e.id, rdnValue(info.subject, 'CN').trim().slice(0, 100));
    const kind = certKind(info.subject);
    out.push({ id: e.id, owner, usage: certIssuer(info.issuer, e.ca), expiresOn, usable: !why, ...(why ? { why } : {}), ...(kind ? { kind } : {}) });
  }
  opts.log?.('main.npki_shown', { listed: ok.length + bad, shown: out.length, unusable: out.filter((c) => !c.usable).length, invalid: invalid + bad });
  return out;
}
