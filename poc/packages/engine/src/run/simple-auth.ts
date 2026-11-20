// 폰에서 시작하는 간편인증(대표 결정 2026-11-19 A): 공동인증서 로그인이 두 번 안 돼 H-01이 간편인증 차례(login.simple_auth, s7e)에서 기다릴 때,
// 폰이 보낸 인증 앱·이름·생년월일·휴대폰 번호로 홈택스 개인용 간편인증 창(OACX, /oacx/index.jsp 틀)을 채우고 [인증 요청]을 누른다.
// 사장님이 휴대폰 인증 앱에서 승인하면 폰이 "승인했어요"를 보내고, 여기서 [인증 완료]를 누른 뒤 실행을 재개한다(s7f가 로그인 표지를 기다린다).
// - 이 차례에서만 돈다(IrRun.simpleAuth가 HandedOff·login.simple_auth를 확인한다). 홈택스 밖으로는 가지 않는다(틀 주소를 확인한다).
// - 값은 칸에만 넣고 로그·일지에 남기지 않는다(결과 코드만).
// 칸 이름은 2026-11-19 홈택스 실화면(공개 로그인 화면, 요청은 누르지 않음)에서 읽고 채워 보았다(카카오톡·네이버·토스·통신사PASS+통신사). [인증 요청] 뒤 화면([인증 완료])은 아직 실화면으로 보지 못했다.
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
/** 통신사PASS의 통신사 칸 값(홈택스 창 select, 2026-11-19 실화면) */
const OACX_CARRIERS: Readonly<Record<string, string>> = { S: 'SKT', K: 'KT', L: 'LGU+', SA: 'SKT알뜰폰', KA: 'KT알뜰폰', LA: 'LGU+알뜰폰' };

export interface SimpleAuthIdentity {
  provider: string;
  name: string;
  /** YYYYMMDD */
  birth: string;
  /** 숫자만 10~11자리(예: 01012345678) */
  phone: string;
  /** 통신사PASS만: 통신사 칸 값(S·K·L·SA·KA·LA) */
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
    // s7d가 [개인용 간편인증] 탭을 눌러 두었다: 그 아래 큰 단추(같은 이름, 보이는 것)를 누르면 창이 열린다
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
    // 통신사PASS: 통신사 칸(값 S·K·L·SA·KA·LA를 가진 select)
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
