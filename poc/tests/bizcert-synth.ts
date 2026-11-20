import { createRequire } from 'node:module';
import type { Browser } from 'playwright-core';
import type { Worker } from 'tesseract.js';
import { formatBizNo } from '@sax/db';
import { cleanDocumentForOcr, cleanPhotoForOcr, IMAGE_LIMITS, imageInfo, ocrScale } from '@sax/docparse/sandbox';

const require = createRequire(import.meta.url);
export const KOR = require('@tesseract.js-data/kor') as { langPath: string; gzip: boolean };

export interface CertSample {
  kind: 'individual' | 'corporate';
  bizNo: string;
  name: string;
  rep: string;
  repSuffix?: string;
  birth?: string;
  open: string;
  corpNo?: string;
  addr: string;
  hq?: string;
  types: string[];
  items: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const lab = (s: string, w = 190) => `<span class="lab" style="width:${w}px">${esc(s)}</span><span class="colon">:</span>`;

export function certHtml(c: CertSample): string {
  const corp = c.kind === 'corporate';
  const rows: string[] = [];
  rows.push(`<div class="row">${lab(corp ? '법인명(단체명)' : '상호')}<span class="val">${esc(c.name)}</span></div>`);
  if (corp) rows.push(`<div class="row">${lab('대표자')}<span class="val">${esc(c.rep)}${c.repSuffix ? ' ' + esc(c.repSuffix) : ''}</span></div>`);
  else rows.push(`<div class="row">${lab('성명')}<span class="val half">${esc(c.rep)}${c.repSuffix ? ' ' + esc(c.repSuffix) : ''}</span>${lab('생년월일', 120)}<span class="val">${esc(c.birth ?? '')}</span></div>`);
  rows.push(`<div class="row">${lab('개업연월일')}<span class="val half">${esc(c.open)}</span>${corp ? `${lab('법인등록번호', 150)}<span class="val">${esc(c.corpNo ?? '')}</span>` : ''}</div>`);
  rows.push(`<div class="row">${lab('사업장소재지')}<span class="val">${esc(c.addr)}</span></div>`);
  if (corp) rows.push(`<div class="row">${lab('본점소재지')}<span class="val">${esc(c.hq ?? c.addr)}</span></div>`);
  const n = Math.max(c.types.length, c.items.length);
  const kinds = Array.from({ length: n }, (_, i) => `<tr><td class="k">${i === 0 ? '업태' : ''}</td><td class="t">${esc(c.types[i] ?? '')}</td><td class="k">${i === 0 ? '종목' : ''}</td><td>${esc(c.items[i] ?? '')}</td></tr>`).join('');
  rows.push(`<div class="row top">${lab('사업의종류')}<table class="kinds">${kinds}</table></div>`);
  rows.push(`<div class="row">${lab('발급사유')}<span class="val">신규</span></div>`);
  if (!corp) rows.push(`<div class="row">${lab('공동사업자')}<span class="val"></span></div>`);
  rows.push(`<div class="row">${lab('사업자 단위 과세 적용사업자 여부', 330)}<span class="val">여( ) 부(V)</span></div>`);
  rows.push(`<div class="row">${lab('전자세금계산서 전용 전자우편주소', 330)}<span class="val"></span></div>`);
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#fff;font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans CJK KR',sans-serif}
.paper{width:860px;padding:36px 40px 60px;background:#fff;border:3px double #333;margin:20px;position:relative;font-size:21px;color:#111;
  background-image:repeating-linear-gradient(45deg,#f2f2f2 0 2px,transparent 2px 9px)}
.no{font-size:14px;color:#444}
h1{text-align:center;letter-spacing:18px;font-size:38px;margin:18px 0 4px}
.sub{text-align:center;margin:0 0 6px}
.reg{text-align:center;font-size:23px;margin:0 0 26px}
.row{display:flex;align-items:baseline;margin:11px 0}
.row.top{align-items:flex-start}
.lab{display:inline-block;text-align:justify;text-align-last:justify;flex:none}
.colon{margin:0 10px}
.val.half{width:260px;flex:none}
.kinds{border-collapse:collapse;font-size:20px}
.kinds td{padding:2px 10px 4px 0}
.kinds .k{padding-right:14px}
.kinds .t{width:220px}
.foot{text-align:center;margin-top:34px}
.chief{text-align:center;font-size:26px;letter-spacing:8px;margin-top:16px}
.seal{position:absolute;right:220px;bottom:36px;width:70px;height:70px;border:4px solid #d22;color:#d22;font-size:15px;display:flex;align-items:center;justify-content:center}
</style><body><div class="paper">
<div class="no">발급번호 : 0000-000-0000-000</div>
<h1>사업자등록증</h1>
<p class="sub">( ${corp ? '법인사업자' : '일반과세자'} )</p>
<p class="reg">등록번호 : ${formatBizNo(c.bizNo)}</p>
${rows.join('\n')}
<p class="foot">2024 년 03 월 04 일</p>
<p class="chief">가상세무서장</p><div class="seal">직인</div>
</div></body>`;
}

export type Variant = 'clean' | 'scan' | 'photo' | 'photo-mild' | 'small' | 'unreadable';

export async function renderCert(browser: Browser, html: string, v: Variant, format: 'png' | 'jpeg'): Promise<Buffer> {
  const dsf = v === 'photo' || v === 'photo-mild' ? 3 : v === 'unreadable' ? 0.6 : v === 'small' ? 1 : 2;
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: dsf });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate((variant) => {
      const p = document.querySelector('.paper') as HTMLElement;
      if (variant === 'scan') {
        p.style.transform = 'rotate(1deg)';
        p.style.filter = 'blur(0.5px)';
      } else if (variant === 'photo') {
        document.body.style.background = '#6b5a48';
        document.body.style.padding = '30px';
        p.style.transform = 'perspective(1600px) rotateX(4deg) rotateY(-3deg) rotate(-2deg)';
        p.style.filter = 'blur(0.8px) brightness(0.78) contrast(0.85)';
        const shade = document.createElement('div');
        shade.style.cssText = 'position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,0.12),rgba(0,0,0,0.22) 70%,rgba(0,0,0,0.3))';
        p.appendChild(shade);
      } else if (variant === 'photo-mild') {
        document.body.style.background = '#8a7a66';
        document.body.style.padding = '30px';
        p.style.transform = 'perspective(1800px) rotateX(3deg) rotate(1.5deg)';
        p.style.filter = 'blur(0.6px)';
        const shade = document.createElement('div');
        shade.style.cssText = 'position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,0.18),rgba(0,0,0,0.3) 35%,rgba(0,0,0,0.42))';
        p.appendChild(shade);
      } else if (variant === 'small') {
        p.style.transform = 'rotate(-0.7deg)';
      } else if (variant === 'unreadable') {
        p.style.filter = 'blur(5px)';
      }
    }, v);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    return format === 'png' ? await page.screenshot({ fullPage: true, type: 'png' }) : await page.screenshot({ fullPage: true, type: 'jpeg', quality: v === 'photo' || v === 'photo-mild' ? 75 : v === 'small' ? 55 : 70 });
  } finally {
    await page.close();
  }
}

export async function sandboxLikeOcr(browser: Browser, worker: Worker, bytes: Buffer, mode: 'document' | 'photo'): Promise<{ text: string; confidence: number }> {
  const info = imageInfo(new Uint8Array(bytes));
  const page = await browser.newPage();
  try {
    const { w, h, data } = await page.evaluate(
      async ({ b64, scale }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin]));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        let s = '';
        for (let i = 0; i < img.data.length; i += 0x8000) s += String.fromCharCode(...img.data.subarray(i, i + 0x8000));
        return { w: c.width, h: c.height, data: btoa(s) };
      },
      { b64: bytes.toString('base64'), scale: ocrScale(info.width, info.height, mode, IMAGE_LIMITS.ocrMaxSide) },
    );
    const rgba = new Uint8ClampedArray(Buffer.from(data, 'base64'));
    if (mode === 'photo') cleanPhotoForOcr(rgba, w, h);
    else cleanDocumentForOcr(rgba, w, h);
    const png = await page.evaluate(
      async ({ b64, w, h }) => {
        const px = Uint8ClampedArray.from(atob(b64), (ch) => ch.charCodeAt(0));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
        const url = c.toDataURL('image/png');
        return url.slice(url.indexOf(',') + 1);
      },
      { b64: Buffer.from(rgba.buffer).toString('base64'), w, h },
    );
    const { data: r } = await worker.recognize(Buffer.from(png, 'base64'), {}, { text: true, blocks: true });
    const lines: string[] = [];
    for (const b of r.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
      const t = String(l.text || '').replace(/\s+$/, '');
      if (t) lines.push(t);
    }
    return { text: lines.length ? lines.join('\n') : String(r.text || ''), confidence: r.confidence };
  } finally {
    await page.close();
  }
}
