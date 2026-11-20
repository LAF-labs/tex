import type { Frame, Page } from 'playwright-core';

/** 폰이 고르는 인증 앱 코드 → 홈택스 창의 글자 */
export const OACX_PROVIDERS: Readonly<Record<string, string>> = {
  kakao: '카카오톡',
  naver: '네이버',
  toss: '토스',
  pass: '통신사PASS',
  kb: '국민인증서',
  shinhan: '신한인증서',
  woori: '우리인증서',
  hana: '하나인증서',
  nh: 'NH인증서',
  ibk: 'IBK인증서',
  kakaobank: '카카오뱅크',
  samsung: '삼성패스',
  banksalad: '뱅크샐러드',
};
const OACX_CARRIERS: Readonly<Record<string, string>> = { S: 'SKT', K: 'KT', L: 'LGU+', SA: 'SKT알뜰폰', KA: 'KT알뜰폰', LA: 'LGU+알뜰폰' };

export interface SimpleAuthIdentity {
  provider: string;
  name: string;
  birth: string;
  phone: string;
  carrier?: string;
}

/** 값 검사(폰에서 온 값). 틀리면 코드. */
export function checkIdentity(d: SimpleAuthIdentity): string | null {
  if (!Object.hasOwn(OACX_PROVIDERS, d.provider)) return 'simple.provider';
  if (typeof d.name !== 'string' || !/^[가-힣A-Za-z][가-힣A-Za-z ]{0,19}$/.test(d.name.trim())) return 'simple.name';
  if (typeof d.birth !== 'string' || !/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d.birth)) return 'simple.birth';
  if (typeof d.phone !== 'string' || !/^01[016789]\d{7,8}$/.test(d.phone)) return 'simple.phone';
  if (d.provider === 'pass' ? !d.carrier || !Object.hasOwn(OACX_CARRIERS, d.carrier) : d.carrier !== undefined) return 'simple.carrier';
  return null;
}

const OACX_URL = /^https:\/\/(www\.)?hometax\.go\.kr\/oacx\//;
const findOacx = (page: Page): Frame | null => page.frames().find((f) => OACX_URL.test(f.url())) ?? null;

async function waitOacx(page: Page, ms: number): Promise<Frame | null> {
  const end = Date.now() + ms;
  for (;;) {
    const f = findOacx(page);
    if (f && (await f.locator('#oacx_name').count().catch(() => 0)) > 0) return f;
    if (Date.now() > end) return null;
    await page.waitForTimeout(300);
  }
}

type SimpleAuthResult = { ok: true } | { ok: false; code: string };

/** 간편인증 창을 열고(이미 열려 있으면 그대로) 칸을 채운 뒤 [인증 요청]을 누른다. */
export async function oacxRequest(page: Page, d: SimpleAuthIdentity): Promise<SimpleAuthResult> {
  const bad = checkIdentity(d);
  if (bad) return { ok: false, code: bad };
  let f = findOacx(page);
  if (!f) {
    const open = page.locator('a.certibtn:visible').filter({ hasText: '개인용' }).first();
    if ((await open.count().catch(() => 0)) === 0) return { ok: false, code: 'simple.no_open_button' };
    await open.click({ timeout: 10_000 }).catch(() => {});
    f = await waitOacx(page, 15_000);
  }
  if (!f) return { ok: false, code: 'simple.no_window' };
  try {
    await f.getByText(OACX_PROVIDERS[d.provider]!, { exact: true }).first().click({ timeout: 10_000 });
    await f.locator('#oacx_name').fill(d.name.trim(), { timeout: 5_000 });
    await f.locator('#oacx_birth').fill(d.birth, { timeout: 5_000 });
    const prefix = d.phone.slice(0, 3);
    await f.locator('#oacx_phone2').locator('xpath=preceding::select[1]').selectOption(prefix, { timeout: 5_000 });
    await f.locator('#oacx_phone2').fill(d.phone.slice(3), { timeout: 5_000 });
    if (d.carrier) {
      const sel = f.locator('select').filter({ has: f.locator('option[value="SA"]') }).first();
      await sel.selectOption(d.carrier, { timeout: 5_000 });
    }
    const all = f.locator('#totalAgree');
    if (!(await all.isChecked().catch(() => false))) await f.locator('label[for="totalAgree"], #totalAgree').first().click({ timeout: 5_000 });
    if (!(await all.isChecked().catch(() => false))) return { ok: false, code: 'simple.agree' };
    await f.locator('#oacx-request-btn-pc').click({ timeout: 5_000 });
  } catch {
    return { ok: false, code: 'simple.fill_failed' };
  }
  return { ok: true };
}

/** 휴대폰 승인 뒤 [인증 완료]를 누른다. 창이 이미 닫혔으면(홈택스가 스스로 넘어감) 그대로 성공으로 본다. */
export async function oacxComplete(page: Page): Promise<SimpleAuthResult> {
  const f = findOacx(page);
  if (!f) return { ok: true };
  const done = f.getByRole('button', { name: /인증\s*완료/ }).first();
  if ((await done.count().catch(() => 0)) === 0) return { ok: false, code: 'simple.no_complete_button' };
  try {
    await done.click({ timeout: 5_000 });
  } catch {
    return { ok: false, code: 'simple.complete_failed' };
  }
  return { ok: true };
}
