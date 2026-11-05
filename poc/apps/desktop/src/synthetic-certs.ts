// PoC-8 시험 자료: 홈택스 민원증명 2종의 서식(국세징수법 시행규칙 별지 제94호, 민원사무처리규정 별지 제5호) 배치를 흉내 낸 합성 서류.
// 이름·번호·세무서는 모두 가짜다. 실제 출력본과 글자 단위로 같지 않다(실물은 PoC-8 측정 스크립트로 잰다).
import { createHash, randomBytes } from 'node:crypto';
import { formatBizNo, syntheticBizNo } from '@sax/db';

export type SyntheticKind = 'national_tax_cert' | 'biz_registration_cert' | 'localtax_cert' | 'biz_registration' | 'closure_cert';
export type DateStyle = 'ko' | 'ko0' | 'dot' | 'dash';

export interface SyntheticCert {
  id: string;
  kind: SyntheticKind;
  html: string;
  /** 추출기가 내야 할 값. 지원하지 않는 종류는 docType null. */
  expected: { docType: 'national_tax_cert' | 'biz_registration_cert' | null; issuedOn: string | null; validUntil: string | null; issuer: string | null; docNo: string | null; bizNo: string | null };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export function fmtDate(iso: string, style: DateStyle): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (style === 'ko') return `${y}년 ${m}월 ${d}일`;
  if (style === 'ko0') return `${y}년 ${pad2(m)}월 ${pad2(d)}일`;
  if (style === 'dot') return `${y}. ${m}. ${d}.`;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

const OFFICES = ['가나', '다라', '마바사', '아자'];
const CORPS = [
  { name: '주식회사 가나다테크', rep: '이가나', corp: true },
  { name: '라마상회', rep: '박라마', corp: false },
  { name: '주식회사 바사아', rep: '최바사', corp: true },
  { name: '자차카 공방', rep: '정자차', corp: false },
];

/** 4-3-4-3 발급번호. 첫 칸은 영문 대문자가 섞일 수 있다(원본확인 입력란). */
function docNo(seed: number): string {
  const n = String(seed * 7_368_787 + 1_234_567_890_123).padStart(14, '0').slice(-14);
  const first = seed % 3 === 0 ? `T${n.slice(1, 4)}` : n.slice(0, 4);
  return `${first}-${n.slice(4, 7)}-${n.slice(7, 11)}-${n.slice(11, 14)}`;
}

/** 서식 라벨은 글자 사이를 띄워 인쇄된다. spaced면 그대로, 아니면 붙여 쓴다. */
const L = (label: string, spaced: boolean) => (spaced ? label.split('').join(' ').replace(/ \( /g, ' (').replace(/ \) /g, ') ') : label);

const PAGE = `<!doctype html><meta charset="utf-8"><style>
@page{size:A4;margin:14mm}body{font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:11pt;color:#000}
h1{text-align:center;font-size:20pt;letter-spacing:8pt;margin:6mm 0}table{border-collapse:collapse;width:100%;margin:2mm 0}
td,th{border:1px solid #000;padding:2mm;vertical-align:middle;font-weight:normal}th{background:#eee;text-align:center}
.r{text-align:right}.c{text-align:center}.small{font-size:9pt}.foot{margin-top:10mm}
.seal{display:inline-block;width:15mm;height:15mm;margin-left:-12mm;vertical-align:middle;border:1.2mm solid #c8322d;border-radius:50%;background:rgba(214,58,50,.35)}</style><body>`;
/** 붉은 직인(글자 없음). 실제 증명서처럼 기관명 위에 겹친다. OCR 전처리가 붉은색을 지우는지 본다. */
const SEAL = '<span class="seal"></span>';

function taxCertHtml(o: { no: string; spaced: boolean; corp: (typeof CORPS)[number]; bizNo: string; issued: string; valid: string; shortened: boolean; style: DateStyle; office: string; deferral: boolean; printedAt: boolean }): string {
  const s = o.spaced;
  const deferral = o.deferral
    ? `<tr><td>징수유예</td><td>${fmtDate(o.issued, o.style)} ~ ${fmtDate(addDays(o.issued, 60), o.style)}</td><td>2026년 1기</td><td>부가가치세</td><td>${fmtDate(addDays(o.issued, 60), o.style)}</td><td class="r">1,200,000</td><td class="r">0</td></tr>`
    : '<tr><td colspan="7" class="c">해당 없음</td></tr>';
  return `${PAGE}
<table><tr><th>${L('발급번호', s)}</th><td>${o.no}</td><th>${L('처리기간', s)}</th><td>즉시 (단, 해외이주용 10일)</td></tr></table>
<h1>납세증명서</h1>
<table>
<tr><th rowspan="3">${L('납세자', s)}<br>인적사항</th><th>성명(상호)</th><td>${o.corp.name}</td></tr>
<tr><th>주민등록번호(사업자등록번호)</th><td>${formatBizNo(o.bizNo)}</td></tr>
<tr><th>주소(사업장)</th><td>서울특별시 가나구 다라로 ${o.no.slice(-3)}</td></tr>
<tr><th>증명서의 사용목적</th><td colspan="2">[√] 대금수령 [ ] 해외이주 [ ] 기타</td></tr>
<tr><th>${L('유효기간', s)}</th><td colspan="2">${fmtDate(o.valid, o.style)}${o.style === 'dash' ? ' 까지' : ''}</td></tr>
<tr><th>증명서의 유효기간을 정한 사유</th><td colspan="2">[${o.shortened ? ' ' : '√'}] 「국세징수법 시행령」 제96조제1항 [${o.shortened ? '√' : ' '}] 기타 (사유: ${o.shortened ? '지정납부기한' : ''})</td></tr>
</table>
<p>연장ㆍ유예 내역 (단위: 원)</p>
<table><tr><th>종류</th><th>기간</th><th>과세기간</th><th>세목</th><th>납부기한</th><th>세액</th><th>가산금</th></tr>${deferral}</table>
<p>물적납세의무 체납내역 (단위: 원)</p>
<table><tr><th>위탁자ㆍ양도담보설정자</th><th>과세기간</th><th>세목</th><th>납부기한</th><th>세액</th><th>가산금</th></tr><tr><td colspan="6" class="c">해당 없음</td></tr></table>
<p>「국세징수법」 제108조 및 같은 법 시행령 제95조에 따라 위의 연장ㆍ유예액 또는 물적납세의무 관련 체납액을 제외하고는 다른 체납액이 없음을 증명합니다.</p>
<p class="small">※ 발급일 현재 지정납부기한이 도래하지 않은 미납국세는 체납액이 아니므로 증명 대상에서 제외됨.</p>
<table class="foot"><tr><th>${L('담당부서', s)}</th><td>민원봉사실</td><td class="c" rowspan="2">${fmtDate(o.issued, o.style)}</td><th>${L('담당자', s)}</th><td>김담당</td></tr>
<tr><th>${L('연락처', s)}</th><td>02-000-0000</td><th colspan="2" class="c">${o.office}${L('세무서장', s)} 직인${SEAL}</th></tr></table>
${o.printedAt ? `<p class="small r">출력일시 ${fmtDate(o.issued, 'dash')} 10:42</p>` : ''}
</body>`;
}

function bizRegHtml(o: { no: string; spaced: boolean; corp: (typeof CORPS)[number]; bizNo: string; issued: string; style: DateStyle; office: string; open: string; reg: string }): string {
  const s = o.spaced;
  return `${PAGE}
<table><tr><th>${L('발급번호', s)}</th><td>${o.no}</td><th>${L('처리기간', s)}</th><td>즉시</td></tr></table>
<h1>사업자등록증명</h1><p class="c">( ${o.corp.corp ? '법인사업자' : '일반과세자'} )</p>
<table>
<tr><th>${L('상호(법인명)', s)}</th><td>${o.corp.name}</td><th>${L('사업자등록번호', s)}</th><td>${formatBizNo(o.bizNo)}</td></tr>
<tr><th>대표자성명(대표유형)</th><td>${o.corp.rep}(단독)</td><th>${L('주민(법인)등록번호', s)}</th><td>${o.corp.corp ? '110111-*******' : '800101-*******'}</td></tr>
<tr><th>${L('사업장소재지', s)}</th><td colspan="3">경기도 마바시 사아로 ${o.no.slice(-3)}</td></tr>
<tr><th>${L('개업일', s)}</th><td>${fmtDate(o.open, o.style)}</td><th>${L('사업자등록일', s)}</th><td>${fmtDate(o.reg, o.style)}</td></tr>
<tr><th>${L('업태', s)}</th><td>서비스</td><th>${L('종목', s)}</th><td>소프트웨어 개발</td></tr>
</table>
<table><tr><th rowspan="2">${L('공동사업자', s)}</th><th>성명(법인명)</th><th>주민(사업자)등록번호</th></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></table>
<p class="c">위와 같이 증명합니다.</p>
<p class="small">※ 위 내용은 발급일 현재 상황으로서 추후 변경될 수 있습니다.</p>
<p class="c foot">${fmtDate(o.issued, o.style)}</p>
<table><tr><th>${L('접수번호', s)}</th><td>${o.no.replace(/\D/g, '').slice(-7)}</td><th>${L('담당부서', s)}</th><td>민원봉사실</td></tr>
<tr><th>${L('담당자', s)}</th><td>김담당</td><th>${L('연락처', s)}</th><td>031-000-0000</td></tr></table>
<p class="c" style="font-size:16pt">${o.office}${L('세무서장', s)} (인)${SEAL}</p>
</body>`;
}

function negativeHtml(kind: 'localtax_cert' | 'biz_registration' | 'closure_cert', bizNo: string, issued: string): string {
  if (kind === 'localtax_cert')
    return `${PAGE}<h1>지방세 납세증명서</h1><table><tr><th>납세자</th><td>라마상회</td></tr><tr><th>사업자등록번호</th><td>${formatBizNo(bizNo)}</td></tr>
<tr><th>1. 증명서 유효기간</th><td>${fmtDate(addDays(issued, 30), 'ko')}</td></tr><tr><th>2. 유효기간을 정한 사유</th><td>「지방세징수법 시행령」 제7조</td></tr></table>
<p>징수유예등 또는 체납처분유예 등 명세: 없음</p><p>「지방세징수법」 제5조에 따라 위와 같이 증명합니다.</p><p class="c">${fmtDate(issued, 'ko')}</p><p class="c">가나구청장 (인)</p></body>`;
  if (kind === 'biz_registration')
    return `${PAGE}<h1>사업자등록증</h1><p class="c">( 일반과세자 )</p><p class="c">등록번호 : ${formatBizNo(bizNo)}</p>
<table><tr><th>상 호</th><td>라마상회</td></tr><tr><th>대 표 자</th><td>박라마</td></tr><tr><th>개 업 연 월 일</th><td>2020 년 01 월 15 일</td></tr>
<tr><th>사업장 소재지</th><td>서울특별시 가나구 다라로 1</td></tr></table><p class="c">${fmtDate(issued, 'ko')}</p><p class="c">가나세무서장</p></body>`;
  return `${PAGE}<table><tr><th>발급번호</th><td>${docNo(99)}</td></tr></table><h1>( 휴업 폐업 ) 사 실 증 명</h1>
<table><tr><th>상호(법인명)</th><td>라마상회</td></tr><tr><th>성명 (대표자)</th><td>박라마</td></tr><tr><th>사업자등록번호</th><td>${formatBizNo(bizNo)}</td></tr>
<tr><th>휴 업 기 간</th><td></td></tr><tr><th>폐 업 일</th><td>${fmtDate(addDays(issued, -40), 'ko')}</td></tr></table><p>위와 같이 증명합니다.</p><p class="c">${fmtDate(issued, 'ko')}</p><p class="c">가나세무서장 (인)</p></body>`;
}

const STYLES: DateStyle[] = ['ko', 'ko0', 'dot', 'dash'];

/** 합성 서류 묶음: 납세증명 8건, 사업자등록증명 8건, 지원하지 않는 서류 3건. */
export function syntheticCerts(): SyntheticCert[] {
  const out: SyntheticCert[] = [];
  for (let i = 0; i < 8; i++) {
    const corp = CORPS[i % CORPS.length]!;
    const bizNo = syntheticBizNo(40 + i);
    const issued = addDays('2026-10-01', i * 3);
    // 30일 원칙(발급일+29·+30 둘 다), 지정납부기한으로 짧아진 경우
    const shortened = i % 4 === 3;
    const valid = shortened ? addDays(issued, 12) : addDays(issued, i % 2 ? 30 : 29);
    const office = OFFICES[i % OFFICES.length]!;
    const no = docNo(i + 1);
    out.push({
      id: `tax-${i}`,
      kind: 'national_tax_cert',
      html: taxCertHtml({ no, spaced: i % 2 === 0, corp, bizNo, issued, valid, shortened, style: STYLES[i % 4]!, office, deferral: i % 3 === 1, printedAt: i % 4 === 2 }),
      expected: { docType: 'national_tax_cert', issuedOn: issued, validUntil: valid, issuer: `${office}세무서장`, docNo: no, bizNo },
    });
  }
  for (let i = 0; i < 8; i++) {
    const corp = CORPS[(i + 1) % CORPS.length]!;
    const bizNo = syntheticBizNo(60 + i);
    const issued = addDays('2026-10-02', i * 4);
    const office = OFFICES[(i + 2) % OFFICES.length]!;
    const no = docNo(i + 20);
    out.push({
      id: `biz-${i}`,
      kind: 'biz_registration_cert',
      html: bizRegHtml({ no, spaced: i % 2 === 1, corp, bizNo, issued, style: STYLES[(i + 1) % 4]!, office, open: addDays('2019-03-02', i * 40), reg: addDays('2019-03-05', i * 40) }),
      expected: { docType: 'biz_registration_cert', issuedOn: issued, validUntil: null, issuer: `${office}세무서장`, docNo: no, bizNo },
    });
  }
  for (const kind of ['localtax_cert', 'biz_registration', 'closure_cert'] as const) {
    out.push({ id: `neg-${kind}`, kind, html: negativeHtml(kind, syntheticBizNo(90), '2026-10-20'), expected: { docType: null, issuedOn: null, validUntil: null, issuer: null, docNo: null, bizNo: null } });
  }
  return out;
}

/** 시연 서류에 얹는 "견본" 표시(사선 글자). 본문 판독에 걸리지 않게 짧은 한 단어만 넣는다. */
export const SAMPLE_MARK = '<div style="position:fixed;top:38%;left:0;right:0;text-align:center;font-size:110px;font-weight:700;color:rgba(200,30,30,.16);transform:rotate(-28deg)">견본</div>';
const marked = (html: string) => html.replace('</body>', `${SAMPLE_MARK}</body>`);

/**
 * 시연용 서류(오늘 기준 날짜, 데모 사업장 이름·번호, "견본" 표시). 모두 가상이다.
 * 납세증명서 정상·임박·만료, 사업자등록증명(만료일은 규칙 추정), 지방세 납세증명(지원 밖 → 확인 필요).
 */
export function demoCerts(today: string, me: { name: string; rep: string; bizNo: string }): Array<{ file: string; html: string }> {
  const corp = { name: me.name, rep: me.rep, corp: false };
  const tax = (issued: string, no: number) => marked(taxCertHtml({ no: docNo(no), spaced: false, corp, bizNo: me.bizNo, issued, valid: addDays(issued, 29), shortened: false, style: 'ko', office: OFFICES[0]!, deferral: false, printedAt: false }));
  return [
    { file: '납세증명서_유효.pdf', html: tax(addDays(today, -3), 101) },
    { file: '납세증명서_임박.pdf', html: tax(addDays(today, -25), 104) },
    { file: '납세증명서_만료.pdf', html: tax(addDays(today, -45), 102) },
    { file: '사업자등록증명.pdf', html: marked(bizRegHtml({ no: docNo(103), spaced: false, corp, bizNo: me.bizNo, issued: addDays(today, -2), style: 'ko', office: OFFICES[0]!, open: '2019-03-02', reg: '2019-03-05' })) },
    { file: '지방세납세증명서.pdf', html: marked(negativeHtml('localtax_cert', me.bizNo, addDays(today, -6))) },
  ];
}

/** 여러 쪽짜리(maxPages 확인용). 쪽마다 같은 납세증명 본문. */
export function multiPageHtml(pages: number): string {
  const one = syntheticCerts()[0]!.html.replace(/^[\s\S]*?<body>/, '').replace('</body>', '');
  return `${PAGE}${Array.from({ length: pages }, (_, i) => `<div style="${i ? 'page-break-before:always' : ''}">${one}</div>`).join('')}</body>`;
}

/** 최소 PDF 작성기(시험 전용): 객체 본문 목록 → xref·trailer를 붙인 바이트. 객체 번호는 1부터 순서대로. */
function writePdf(objs: Buffer[], trailerExtra = ''): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objs.forEach((body, i) => {
    offsets.push(at);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(b);
    at += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((off) => `${String(off).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${at}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);

/**
 * 스캐너·복합기가 만드는 '검색 가능 PDF' 흉내: 쪽 전체 그림(JPEG) 위에 보이지 않는 글자(렌더 모드 3 Tr)를 덧입힌다.
 * 글자는 ASCII(Helvetica)라 한글 서류 흉내는 아니다. docparse가 이 층을 원본 텍스트로 믿지 않는지(scanned) 본다.
 */
export function scannedTestPdf(jpeg: Buffer, width: number, height: number, text: string): Uint8Array {
  const content = Buffer.from(`q 595 0 0 842 0 0 cm /Im1 Do Q BT 3 Tr /F1 12 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`, 'latin1');
  return writePdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg),
    stream('', content),
  ]);
}

// ── 암호 PDF(시험 전용): 표준 보안 처리기 V1·R2(RC4 40비트). 열기 암호·권한 암호 경로를 의존성 없이 만든다. ──
const PASSWORD_PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const padPassword = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PASSWORD_PAD]).subarray(0, 32);

/** 한 쪽짜리 ASCII 본문 PDF. userPassword가 빈 문자열이면 권한 암호만 걸린 PDF(그냥 열린다). */
export function encryptedTestPdf(userPassword: string, ownerPassword: string, text: string): Uint8Array {
  const id = randomBytes(16);
  const o = rc4(md5(padPassword(ownerPassword || userPassword)).subarray(0, 5), padPassword(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(-44);
  const key = md5(padPassword(userPassword), o, p, id).subarray(0, 5);
  const u = rc4(key, PASSWORD_PAD);
  const objKey = (n: number) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  const content = rc4(objKey(5), Buffer.from(`BT /F1 16 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`, 'latin1'));
  return writePdf(
    [
      Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
      Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
      Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
      stream('', content),
      Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P -44 >>`),
    ],
    ` /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`,
  );
}

/** printToPDF 결과의 /ToUnicode 키를 같은 길이의 다른 키로 바꿔 글자 대응표를 끊는다(텍스트 층 판정 시험용). 바꾼 수를 돌려준다. */
export function breakToUnicode(pdf: Uint8Array): { pdf: Uint8Array; replaced: number } {
  const b = Buffer.from(pdf);
  const from = Buffer.from('/ToUnicode');
  const to = Buffer.from('/ToUnicodX');
  let replaced = 0;
  for (let i = b.indexOf(from); i >= 0; i = b.indexOf(from, i + from.length)) {
    to.copy(b, i);
    replaced++;
  }
  return { pdf: new Uint8Array(b), replaced };
}
