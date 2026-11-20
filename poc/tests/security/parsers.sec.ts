import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { describe, it } from 'node:test';
import { FUZZ_ITER, FUZZ_SEED, pick, rng } from './lib/fuzz.ts';

type Gen = (r: () => number) => string | Uint8Array | Promise<Uint8Array>;
interface ParserCase {
  name: string;
  module: string;
  export: string;
  input: Gen;
  call?: (fn: (...a: unknown[]) => unknown, x: string | Uint8Array, mod: Record<string, unknown>) => unknown;
  okThrow?: (e: unknown) => boolean;
  allReject?: boolean;
  check?: (out: unknown, mod: Record<string, unknown>) => string | null;
  perCallMs?: number;
  owner: string;
}

const CHARS = ['0', '1', '9', '-', ' ', '\n', '\t', '사', '업', '자', '등', '록', '번', '호', '대', '표', '년', '월', '일', ':', '(', ')', '​', '‮', '­', '�', '𝟙', 'Ａ', '\u0000', '<', '>', '"', '\\'];
const TEMPLATES = ['사업자등록번호 : ', '상 호 : ', '대 표 자 : ', '개업연월일 : ', '사업장소재지 : ', '발급일 ', '유효기간 ', '주민등록번호 '];

const textGen: Gen = (r) => {
  const lines: string[] = [];
  const n = 1 + Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.4) lines.push(pick(r, TEMPLATES) + Array.from({ length: Math.floor(r() * 30) }, () => pick(r, CHARS)).join(''));
    else if (k < 0.5) lines.push(pick(r, CHARS).repeat(1 + Math.floor(r() * 20_000)));
    else if (k < 0.6) lines.push('1-'.repeat(Math.floor(r() * 5_000)) + '!');
    else lines.push(Array.from({ length: Math.floor(r() * 120) }, () => pick(r, CHARS)).join(''));
  }
  return lines.join(pick(r, ['\n', '\r\n', ' ']));
};

const MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  zip: [0x50, 0x4b, 0x03, 0x04],
  heic: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
};
const binGen = (kind: keyof typeof MAGIC) => (r: () => number): Uint8Array => {
  const len = Math.floor(r() * 4096);
  const b = new Uint8Array(MAGIC[kind]!.length + len);
  b.set(MAGIC[kind]!);
  for (let i = MAGIC[kind]!.length; i < b.length; i++) b[i] = Math.floor(r() * 256);
  return b;
};

const coded = (e: unknown): boolean => e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && ['SandboxError', 'DocparseError'].includes(e.constructor.name);

const hostRefuse = {
  pdf: () => Promise.reject(new Error('host called: pdf')),
  image: () => Promise.reject(new Error('host called: image')),
  sheet: () => Promise.reject(new Error('host called: sheet')),
};

const IMG_MAX_SIDE = 12_000;
const IMG_MAX_PIXELS = 50_000_000;
const imageCheck = (o: unknown): string | null => {
  const i = o as { width: number; height: number };
  if (!(i.width > 0 && i.height > 0)) return `크기 0을 통과시킴 ${i.width}x${i.height}`;
  if (i.width > IMG_MAX_SIDE || i.height > IMG_MAX_SIDE || i.width * i.height > IMG_MAX_PIXELS) return `상한을 넘는 크기를 통과시킴 ${i.width}x${i.height}`;
  return null;
};

const dim = (r: () => number) => pick(r, [0, 1, 7, 640, 4000, 11_999, 12_000, 12_001, 65_535, 100_000, 0xffffffff, Math.floor(r() * 20_000)]);

const pngGen: Gen = (r) => {
  const tail = Math.floor(r() * 64);
  const b = new Uint8Array(33 + tail);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, dim(r) >>> 0);
  v.setUint32(20, dim(r) >>> 0);
  for (let i = 24; i < b.length; i++) b[i] = Math.floor(r() * 256);
  if (r() < 0.1) return b.slice(0, Math.floor(r() * 24));
  return b;
};

const jpegGen: Gen = (r) => {
  const out: number[] = [0xff, 0xd8];
  const n = Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.35) {
      const h = Math.min(dim(r), 0xffff);
      const w = Math.min(dim(r), 0xffff);
      out.push(0xff, pick(r, [0xc0, 0xc1, 0xc2, 0xc4, 0xcc]), 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    } else if (k < 0.7) {
      const len = pick(r, [0, 1, 2, 16, 0xffff, Math.floor(r() * 300)]);
      out.push(0xff, 0xe0 + Math.floor(r() * 16), len >> 8, len & 0xff);
      for (let j = 0; j < Math.min(len, 64); j++) out.push(Math.floor(r() * 256));
    } else if (k < 0.85) out.push(0xff, 0xff, 0xff, Math.floor(r() * 256));
    else out.push(Math.floor(r() * 256));
  }
  if (r() < 0.5) out.push(0xff, 0xd9);
  return new Uint8Array(out);
};

const svgGen = (r: () => number): Uint8Array => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('http://127.0.0.1:9/${Math.floor(r() * 1e6)}')</script></svg>`);

let xlsxBase: Uint8Array | null = null;
const xlsxGen: Gen = async (r) => {
  if (!xlsxBase) {
    const { deliveryXlsx } = await import('@sax/docparse/fixtures');
    xlsxBase = await deliveryXlsx().bytes;
  }
  const b = xlsxBase.slice();
  const flips = Math.floor(r() * 5);
  for (let i = 0; i < flips; i++) b[Math.floor(r() * b.length)]! ^= 1 << Math.floor(r() * 8);
  return r() < 0.15 ? b.slice(0, Math.floor(r() * b.length)) : b;
};

const derLen = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlvOf = (tag: number, ...body: Uint8Array[]): Uint8Array => {
  const v = Buffer.concat(body);
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...derLen(v.length)]), v]));
};
const derOid = (o: string): Uint8Array => {
  const a = o.split('.').map(Number);
  const out = [a[0]! * 40 + a[1]!];
  for (const x of a.slice(2)) {
    const enc = [x & 0x7f];
    for (let v = x >>> 7; v > 0; v >>>= 7) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlvOf(0x06, Buffer.from(out));
};
const rdn = (o: string, v: string, tag = 0x0c) => tlvOf(0x31, tlvOf(0x30, derOid(o), tlvOf(tag, Buffer.from(v, tag === 0x0c ? 'utf8' : 'latin1'))));
const certDer = (cn: string, pad = 0): Uint8Array => {
  const nm = (x: string) => tlvOf(0x30, rdn('2.5.4.6', 'kr', 0x13), rdn('2.5.4.10', 'yessign', 0x13), rdn('2.5.4.11', '개인'), rdn('2.5.4.3', x));
  const alg = tlvOf(0x30, derOid('1.3.101.112'));
  const tbs = tlvOf(0x30, tlvOf(0xa0, tlvOf(0x02, Buffer.from([2]))), tlvOf(0x02, Buffer.from([1, 0x23])), alg, nm('TEST-CA'), tlvOf(0x30, tlvOf(0x17, Buffer.from('260102030405Z')), tlvOf(0x17, Buffer.from('270102235959Z'))), nm(cn), tlvOf(0x30, alg, tlvOf(0x03, Buffer.alloc(33))), ...(pad ? [tlvOf(0xa3, Buffer.alloc(pad))] : []));
  return tlvOf(0x30, tbs, alg, tlvOf(0x03, Buffer.alloc(65, 7)));
};

const certGen: Gen = (r) => {
  const base = certDer(`TEST홍길동()${Math.floor(r() * 1e12)}`);
  const k = r();
  if (k < 0.08) return certDer('TEST', 8200);
  if (k < 0.14) return new TextEncoder().encode(`-----BEGIN CERTIFICATE-----\n${Buffer.from(base).toString('base64')}\n-----END CERTIFICATE-----\n`);
  if (k < 0.2) return new Uint8Array([0x30, 0x80, ...base.subarray(2), 0, 0]);
  if (k < 0.26) return new Uint8Array([...base, Math.floor(r() * 256)]);
  const b = base.slice();
  const flips = Math.floor(r() * 5);
  for (let i = 0; i < flips; i++) {
    const at = Math.floor(r() * b.length);
    if (r() < 0.3) b[at] = pick(r, [0x80, 0x81, 0x82, 0x84, 0xff, 0x00]);
    else b[at]! ^= 1 << Math.floor(r() * 8);
  }
  return r() < 0.15 ? b.slice(0, Math.floor(r() * b.length)) : b;
};

export const PARSERS: readonly ParserCase[] = [
  {
    name: 'OCR 사업자등록증 문자 파서 parseBizCert',
    module: '@sax/engine/bizcert',
    export: 'parseBizCert',
    input: textGen,
    check: (o) => (o && typeof o === 'object' && 'fields' in o ? null : '결과에 fields 없음'),
    owner: 'M5-1(지금 돈다)',
  },
  {
    name: '문서 메타 추출 extractDocMeta(민원증명 PDF 글자)',
    module: '@sax/engine/docmeta',
    export: 'extractDocMeta',
    input: textGen,
    check: (o, m) => (typeof m.validateDocMeta !== 'function' || (m.validateDocMeta as (v: unknown) => unknown)(o) ? null : 'validateDocMeta가 거부하는 결과'),
    owner: 'M5-1(지금 돈다)',
  },
  {
    name: '그림 머리 imageInfo(PNG)',
    module: '@sax/docparse/sandbox',
    export: 'imageInfo',
    input: pngGen,
    okThrow: coded,
    check: imageCheck,
    owner: 'M6-12(docparse M6-4)',
  },
  {
    name: '그림 머리 imageInfo(JPEG)',
    module: '@sax/docparse/sandbox',
    export: 'imageInfo',
    input: jpegGen,
    okThrow: coded,
    check: imageCheck,
    owner: 'M6-12(docparse M6-4)',
  },
  {
    name: 'parse 입구(HEIC·SVG·임의 매직): 샌드박스를 부르지 않고 코드로 거부',
    module: '@sax/docparse',
    export: 'parse',
    input: (r) => (r() < 0.5 ? binGen('heic')(r) : pick(r, [binGen('png'), binGen('jpeg'), binGen('zip'), svgGen])(r)),
    call: (fn, x) => fn(x, pick(rng(x.length), ['receipt', 'certificate', 'settlement', 'insurance_notice']), hostRefuse),
    okThrow: (e) => coded(e) && !String((e as Error).message).startsWith('host called'),
    allReject: true,
    owner: 'M6-12(docparse M6-4)',
  },
  {
    name: '표 readXlsx → parseSettlement(정상 xlsx 비트 변조·자르기)',
    module: '@sax/docparse/sandbox',
    export: 'readXlsx',
    input: xlsxGen,
    call: async (fn, x) => {
      const sheet = await fn(x);
      const { parseSettlement, validateSandboxOutput } = await import('@sax/docparse');
      const ok = validateSandboxOutput('sheet', sheet);
      if (!ok) return { bad: 'validateSandboxOutput(sheet)가 거부하는 출력' };
      parseSettlement(ok);
      return { bad: null };
    },
    okThrow: coded,
    check: (o) => (o as { bad: string | null }).bad,
    perCallMs: 10_000,
    owner: 'M6-12(docparse M6-5)',
  },
  {
    name: '인증서 메타 readCertInfo(signCert.der 변조·8KB 초과·DER 아님)',
    module: '@sax/docparse/sandbox',
    export: 'readCertInfo',
    input: certGen,
    call: async (fn, x) => {
      const info = fn(x);
      const { validateSandboxOutput } = await import('@sax/docparse');
      if (!validateSandboxOutput('certInfo', info)) return { bad: 'validateSandboxOutput(certInfo)가 거부하는 출력' };
      const raw = x as Uint8Array;
      if (raw.length > 8192) return { bad: `8KB 초과(${raw.length})를 통과시킴` };
      if (raw[0] !== 0x30 || raw[1] === 0x80) return { bad: 'DER 아닌 입력(PEM·BER)을 통과시킴' };
      return { bad: null };
    },
    okThrow: (e) => coded(e) && ['cert_invalid', 'input_size'].includes((e as { code: string }).code),
    check: (o) => (o as { bad: string | null }).bad,
    owner: 'M6-12(docparse certInfo, D05 §6 (2))',
  },
  {
    name: '영수증 문자 parseReceipt(OCR 글자)',
    module: '@sax/docparse',
    export: 'parseReceipt',
    input: textGen,
    call: (fn, x) => fn({ text: x, ocrConfidence: 70, today: '2026-11-06' }),
    check: (o) => (o && typeof o === 'object' && (o as { result?: { extractor?: string } }).result?.extractor === 'receipt-v1' ? null : 'result.extractor가 receipt-v1이 아님'),
    owner: 'M6-12(docparse M6-4)',
  },
];

async function load(c: ParserCase): Promise<{ fn: (x: unknown) => unknown; mod: Record<string, unknown> } | null> {
  try {
    const mod = (await import(c.module)) as Record<string, unknown>;
    const fn = mod[c.export];
    return typeof fn === 'function' ? { fn: fn as (x: unknown) => unknown, mod } : null;
  } catch {
    return null;
  }
}

describe('M6-12 파서 퍼징 하네스', async () => {
  const loaded = await Promise.all(PARSERS.map(load));
  PARSERS.forEach((c, idx) => {
    const l = loaded[idx];
    const iter = Math.min(FUZZ_ITER, 200);
    it(`${c.name}: ${iter}회 멈춤 없음·결과 검사 (씨앗 ${FUZZ_SEED})`, { skip: l ? false : `${c.module}#${c.export} 없음 — ${c.owner}` }, async () => {
      const r = rng(FUZZ_SEED + idx);
      const limit = c.perCallMs ?? 5_000;
      let threw = 0;
      for (let i = 0; i < iter; i++) {
        const x = await c.input(r);
        const t = performance.now();
        let out: unknown;
        try {
          out = await (c.call ? c.call(l!.fn as (...a: unknown[]) => unknown, x, l!.mod) : l!.fn(x));
        } catch (e) {
          assert.ok(!c.okThrow || c.okThrow(e), `${c.name} 회차 ${i}: 코드 없는 예외 ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
          threw++;
          continue;
        } finally {
          const ms = performance.now() - t;
          assert.ok(ms < limit, `${c.name} 회차 ${i}: ${ms.toFixed(0)}ms > ${limit}ms (입력 길이 ${x.length})`);
        }
        const bad = c.check?.(out, l!.mod);
        assert.equal(bad ?? null, null, `${c.name} 회차 ${i}: ${bad}`);
      }
      if (c.allReject) assert.equal(threw, iter, `${c.name}: 받지 않는 형식을 ${iter - threw}건 통과시킴`);
      else assert.ok(threw < iter, `${c.name}: 모든 입력에서 예외`);
    });
  });

  it('readCertInfo 고정 대조: 정상 합성 DER은 읽고, 8KB 초과는 input_size, PEM·BER 무한 길이·뒤 덧붙임은 cert_invalid', async (t) => {
    const m = (await import('@sax/docparse/sandbox').catch(() => null)) as Record<string, unknown> | null;
    if (typeof m?.readCertInfo !== 'function') return t.skip('@sax/docparse/sandbox#readCertInfo 없음');
    const read = m.readCertInfo as (b: Uint8Array) => { subject: string };
    const codeOf = (b: Uint8Array) => {
      try {
        read(b);
        return 'ok';
      } catch (e) {
        return coded(e) ? (e as { code: string }).code : `throw:${(e as Error).message}`;
      }
    };
    const base = certDer('TEST홍길동()0001');
    assert.match(read(base).subject, /^CN=TEST홍길동\(\)0001,OU=개인,O=yessign,C=kr$/);
    assert.equal(codeOf(certDer('TEST', 8200)), 'input_size');
    assert.equal(codeOf(new TextEncoder().encode(`-----BEGIN CERTIFICATE-----\n${Buffer.from(base).toString('base64')}\n-----END CERTIFICATE-----\n`)), 'cert_invalid');
    assert.equal(codeOf(new Uint8Array([0x30, 0x80, ...base.subarray(2), 0, 0])), 'cert_invalid');
    assert.equal(codeOf(new Uint8Array([...base, 0])), 'cert_invalid');
  });

  it.todo('숨김 텍스트·인젝션 회귀(흰 글자·0pt·화면 밖·주석 레이어 PDF, 숨김 시트·셀 주석 엑셀)를 injection.sec.ts 코퍼스에 추가 — M6-12');
  it.todo('파서 라이브러리를 ADR-028 의존성 갱신 목록에 등록 — M6-12(docparse 의존성 확정 뒤)');
});

interface Trap {
  hits: string[];
  restore: () => void;
}
function trapEgressAndEval(): Trap {
  const hits: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, eval: g.eval, Function: g.Function, connect: net.Socket.prototype.connect, lookup: dns.lookup, plookup: dns.promises.lookup };
  g.fetch = (...a: unknown[]) => {
    hits.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('egress blocked'));
  };
  g.eval = (x: unknown) => {
    hits.push(`eval ${String(x).slice(0, 40)}`);
    throw new Error('eval blocked');
  };
  g.Function = function (...a: unknown[]) {
    hits.push(`Function ${String(a.at(-1)).slice(0, 40)}`);
    throw new Error('Function blocked');
  };
  net.Socket.prototype.connect = function (this: net.Socket, ...a: unknown[]) {
    hits.push(`socket ${JSON.stringify(a[0])}`);
    this.destroy(new Error('egress blocked'));
    return this;
  } as typeof net.Socket.prototype.connect;
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    hits.push(`dns ${host}`);
    const cb = rest.at(-1);
    if (typeof cb === 'function') queueMicrotask(() => (cb as (e: Error) => void)(new Error('egress blocked')));
  };
  (dns.promises as { lookup: unknown }).lookup = (host: string) => {
    hits.push(`dns ${host}`);
    return Promise.reject(new Error('egress blocked'));
  };
  return {
    hits,
    restore: () => {
      g.fetch = saved.fetch;
      g.eval = saved.eval;
      g.Function = saved.Function;
      net.Socket.prototype.connect = saved.connect;
      (dns as { lookup: unknown }).lookup = saved.lookup;
      (dns.promises as { lookup: unknown }).lookup = saved.plookup;
    },
  };
}

describe('M6-12 거부해야 하는 것(docparse 시드 코퍼스, 송신·eval 0)', async () => {
  let api: { parse: (b: Uint8Array, k: string, h: unknown) => Promise<unknown>; DocparseError: new (c: string) => Error; readSheetBytes: (b: Uint8Array) => Promise<unknown>; seedCorpus: () => { name: string; target: string; bytes: () => Promise<Uint8Array>; expect: { reject: string[] } | { ignore: string[] } }[]; CANARY: string } | null = null;
  try {
    const [main, sandbox, fixtures] = await Promise.all([import('@sax/docparse'), import('@sax/docparse/sandbox'), import('@sax/docparse/fixtures')]);
    api = { parse: main.parse as never, DocparseError: main.DocparseError, readSheetBytes: sandbox.readSheetBytes, seedCorpus: fixtures.seedCorpus as never, CANARY: fixtures.CANARY };
    for (const op of ['pdf', 'image', 'sheet'] as const) main.validateSandboxOutput(op, {});
    main.validateParseOutcome({});
  } catch {
    api = null;
  }
  const skip = api ? false : '@sax/docparse(·/sandbox·/fixtures) 없음';
  const seeds = api ? api.seedCorpus().filter((s) => s.target !== 'pdf') : [];
  const code = (e: unknown) => (e instanceof Error && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : `throw:${(e as Error)?.constructor?.name}:${(e as Error)?.message}`);
  const host = api && {
    pdf: () => Promise.reject(new Error('host called: pdf')),
    image: () => Promise.reject(new Error('host called: image')),
    sheet: async (b: Uint8Array) => {
      try {
        return await api!.readSheetBytes(b);
      } catch (e) {
        throw new api!.DocparseError(code(e));
      }
    },
  };

  it('코퍼스가 네 갈래를 덮는다: 외부 주소(송신 시도)·폭탄 압축·대용량·디코드 폭탄', { skip }, () => {
    const names = seeds.map((s) => s.name);
    for (const want of ['xml-xxe.xlsx', 'external-link.xlsx', 'data-connection.xlsx', 'svg-script.svg', 'zip-bomb-ratio.xlsx', 'zip-bomb-lying-size.xlsx', 'xml-billion-laughs.xlsx', 'oversize-16mb.bin', 'png-dimension-bomb.png', 'jpeg-dimension-bomb.jpg']) assert.ok(names.includes(want), `시드 ${want} 없음`);
  });

  for (const seed of seeds) {
    it(`${seed.name}: ${'reject' in seed.expect ? `거부(${seed.expect.reject.join('|')})` : `읽되 무시(${seed.expect.ignore.join('·')})`}, 송신·eval 0`, { skip }, async () => {
      const bytes = await seed.bytes();
      const kind = seed.target === 'image' ? 'receipt' : 'settlement';
      const trap = trapEgressAndEval();
      const t = performance.now();
      let got: string;
      let out: unknown = null;
      try {
        out = await api!.parse(bytes, kind, host);
        got = 'ok';
      } catch (e) {
        got = code(e);
      } finally {
        trap.restore();
      }
      const ms = performance.now() - t;
      assert.deepEqual(trap.hits, [], `송신·eval 시도: ${trap.hits.join(', ')}`);
      assert.ok(ms < 15_000, `${seed.name}: ${ms.toFixed(0)}ms`);
      if ('reject' in seed.expect) assert.ok(seed.expect.reject.includes(got), `${seed.name}: ${got}`);
      else {
        assert.ok(got === 'ok' || got === 'format_not_recognized', `${seed.name}: ${got}`);
        if (out && seed.name !== 'csv-formula-injection.csv') assert.ok(!JSON.stringify(out).includes(api!.CANARY), '숨기거나 무시할 내용이 결과에 새어 나옴');
      }
    });
  }

  it('가로채기 자체가 동작한다(양성 대조)', { skip }, async () => {
    const trap = trapEgressAndEval();
    try {
      await fetch('http://127.0.0.1:9/x').catch(() => null);
      assert.throws(() => (globalThis as { eval: (x: string) => unknown }).eval('1'));
      await new Promise<void>((res) => {
        const s = net.connect(9, '127.0.0.1');
        s.on('error', () => res());
        s.on('close', () => res());
      });
    } finally {
      trap.restore();
    }
    assert.ok(trap.hits.some((h) => h.startsWith('fetch')) && trap.hits.some((h) => h.startsWith('eval')) && trap.hits.some((h) => h.startsWith('socket')), trap.hits.join(', '));
  });
});
