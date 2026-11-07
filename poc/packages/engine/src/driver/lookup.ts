// 조회 포트의 Playwright 구현(M2-3, D02 §4.4, D03 §5.6). 기준은 H01Runner.lookup이다.
// - 조회 화면은 허용 origin 팝업(window.open)에서 읽고 닫는다. 원래 탭은 실패 신호를 읽기만 한다(금고가 새 탭 만들기를 막는다).
// - 결과 준비 신호(ready, data-count)가 정확히 하나이고 행 수가 같아야 한다. 아니면 조회 실패다(부재 증거가 아니다).
//   빈 표와 아직 그리지 않은 표를 가르기 위해서다(기준선이 비어 보이면 예전 건이 새 건으로 잡힌다).
// - 네비게이션은 집행기 자리(beforeAction('navigate'))를 먼저 받는다. 팝업의 주소·본문 문구·HTTP 상태도 집행기가 본다(차단 신호).
//   걸쇠가 걸리면 그 코드(portal.blocked 등)를 돌려준다. judgeVerify는 그 코드면 더 조회하지 않고 unknown이다.
// - 행 값은 화면 문구 그대로다. match 대조·정규화는 judgeVerify가 한다. 값은 저널·로그에 남기지 않는다(⑦).
// 잔여(H01Runner와 같음): noopener 팝업은 금고 중계가 노출하지 않아 조회 탭이 opener로 발급 탭에 닿을 수 있다. 클릭 직전 재계산이 값 변경을 잡는다.
import type { Page, Response } from 'playwright-core';
import type { ActResult } from '../core/page.ts';
import type { LookupPort, LookupRequest, LookupResult, LookupRow } from '../core/verify.ts';
import { hostAllowed } from '../core/validate.ts';
import type { LookupDef } from '../portal.ts';

/** 집행기에서 조회 포트가 쓰는 부분(RunEnforcer). */
export interface LookupPolicy {
  beforeAction(kind: 'navigate'): Promise<ActResult>;
  settled(): Promise<ActResult>;
  observe(where: { url?: string; text?: string }): void;
  observeStatus(status: number, document: boolean): void;
  readonly halted: string | null;
}

export interface PopupLookupInput {
  /** 실행 탭(조회 팝업을 여는 곳). */
  page: Page;
  /** 포털 origin(조회 경로의 기준). */
  origin: string;
  /** verify.lookup.playbook(manifest.lookupsUsed id) → 조회 화면 정의. 없는 id는 lookup.unknown_playbook. */
  defs: ReadonlyMap<string, LookupDef>;
  policy: LookupPolicy;
  /** 포털 호스트(HTTP 상태를 볼 응답). */
  domains: readonly string[];
  /** 팝업·준비 신호 대기 상한(기본 10초, H01Runner와 같음). */
  timeoutMs?: number;
}

export class PopupLookupPort implements LookupPort {
  private readonly i: PopupLookupInput;

  constructor(i: PopupLookupInput) {
    this.i = i;
  }

  async run(req: LookupRequest): Promise<LookupResult> {
    const def = this.i.defs.get(req.playbook);
    if (!def) return { ok: false, code: 'lookup.unknown_playbook' };
    const url = new URL(def.path, this.i.origin);
    for (const [k, q] of Object.entries(def.query)) if (q) url.searchParams.set(q, req.match[k] ?? '');
    const a = await this.i.policy.beforeAction('navigate');
    if (!a.ok) return { ok: false, code: a.code };
    const timeout = this.i.timeoutMs ?? 10_000;
    // 팝업의 포털 응답(HTTP 403·429 규칙)은 컨텍스트에서 듣는다(실행 탭 것은 wireRun이 본다). 단 금고는 팝업을 첫 문서 커밋의
    // origin을 확인한 뒤에야 엔진에 붙이므로(D05 §3.3, relay.decide) 팝업 첫 문서 응답은 엔진에 오지 않는다(실측). 그 문서의 차단은
    // 주소·본문 문구(observe)로 본다. 그 뒤 하위 요청의 응답만 여기로 온다.
    const ctx = this.i.page.context();
    const onResponse = (r: Response) => {
      let portal = false;
      try {
        portal = hostAllowed(new URL(r.url()).hostname, this.i.domains);
      } catch {
        // 주소가 아니면 포털 응답이 아니다
      }
      const f = r.frame();
      if (!portal || f.page() === this.i.page) return;
      this.i.policy.observeStatus(r.status(), r.request().resourceType() === 'document' && f.parentFrame() === null);
    };
    ctx.on('response', onResponse);
    let popup: Page;
    try {
      [popup] = await Promise.all([
        this.i.page.waitForEvent('popup', { timeout }),
        this.i.page.evaluate((u) => {
          window.open(u, '_blank');
        }, url.toString()),
      ]);
    } catch {
      ctx.off('response', onResponse);
      return { ok: false, code: 'lookup.popup_failed' };
    }
    const onNav = (f: ReturnType<Page['mainFrame']>) => {
      if (f === popup.mainFrame()) this.i.policy.observe({ url: f.url() });
    };
    popup.on('framenavigated', onNav);
    try {
      this.i.policy.observe({ url: popup.url() });
      await popup.waitForLoadState('domcontentloaded', { timeout });
      this.i.policy.observe({ text: await popup.locator('body').innerText({ timeout }).catch(() => '') });
      const s = await this.i.policy.settled();
      if (!s.ok) return { ok: false, code: s.code };
      if (this.i.policy.halted) return { ok: false, code: this.i.policy.halted };
      const ready = popup.locator(def.ready);
      await ready.first().waitFor({ state: 'attached', timeout });
      if ((await ready.count()) !== 1) return { ok: false, code: 'lookup.ready_ambiguous' };
      const count = Number(await ready.getAttribute('data-count'));
      const rows: LookupRow[] = await popup
        .locator(def.rows)
        .evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((td) => [td.getAttribute('data-k') ?? '', td.textContent ?? '']))));
      if (!Number.isSafeInteger(count) || count !== rows.length) return { ok: false, code: 'lookup.incomplete' };
      if (this.i.policy.halted) return { ok: false, code: this.i.policy.halted };
      return { ok: true, rows };
    } catch {
      return { ok: false, code: this.i.policy.halted ?? 'lookup.failed' };
    } finally {
      popup.off('framenavigated', onNav);
      ctx.off('response', onResponse);
      await popup.close().catch(() => {});
    }
  }
}
