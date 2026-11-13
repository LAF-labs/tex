// 실행 탭 이벤트 배선(M2-4 D): Playwright·금고 이벤트 → 집행기·대화상자 정책·커밋 가드.
// - 주 프레임 네비게이션 → RunEnforcer.observe({url}), load 뒤 본문 → observe({text})(문구는 저장하지 않는다)
// - 포털 호스트 응답 → observeStatus(status, document)
// - 대화상자 → RunEnforcer.observe({text}) 뒤 GuardedActuator.dialog(정책대로 수락·거부)
// - 금고 commit.body_compared → CommitGuard.onBodyCompared, 가드 정지 → RunEnforcer.haltFor(가드 생성 때 stop에 넘긴다)
// - FetchInterceptor 시작·정지, 끝나면 가드 해제(run.end·Chrome 재기동)
// - 새 창(팝업, IR rev v1.3.6 closeWindows): 제목이 패키지 패턴에 맞는 안내 창만 닫는다. 다른 창(조회 팝업 등)은 건드리지 않는다. 제목은 남기지 않는다.
import type { Dialog, Page, Response } from 'playwright-core';
import type { DialogHandle, GuardedActuator } from '../core/actuator.ts';
import type { DialogKind } from '../core/dialog.ts';
import { hostAllowed } from '../core/validate.ts';
import type { FetchInterceptor } from '../commitguard/cdp.ts';
import type { CommitGuard } from '../commitguard/guard.ts';
import type { CommitBodyComparedEvent } from '../commitguard/rc1.ts';
import type { RunEnforcer } from '../enforcer.ts';
import type { PageReader } from '../core/page.ts';
import { normalizeName } from '../core/constants.ts';

/** 새 창 제목을 기다리는 상한(ms). 안내 창은 바로 그려진다. */
export const POPUP_TITLE_WAIT_MS = 10_000;

export interface RunWiringInput {
  page: Page;
  reader: PageReader;
  enforcer: RunEnforcer;
  actuator: GuardedActuator;
  domains: readonly string[];
  guard?: CommitGuard;
  interceptor?: FetchInterceptor;
  /** 금고 이벤트 구독(VaultClient.on). */
  vaultOn?: (name: string, fn: (data: Record<string, unknown>) => void) => () => void;
  /** 닫을 안내 창 제목 패턴(IR closeWindows, ^…$). */
  closeWindows?: readonly RegExp[];
  /** 창을 닫았거나 둔 것을 저널에 남긴다(값 없음). */
  journal?: (type: string, payload: Record<string, string>) => void;
}

export interface RunWiring {
  /** 배선을 걷고 가드를 해제한다. */
  dispose(): Promise<void>;
}

const DIALOG_KINDS = new Set<DialogKind>(['alert', 'confirm', 'prompt', 'beforeunload']);

export async function wireRun(i: RunWiringInput): Promise<RunWiring> {
  const { page, enforcer } = i;
  const main = () => page.mainFrame();
  const portal = (url: string) => {
    try {
      return hostAllowed(new URL(url).hostname, i.domains);
    } catch {
      return false;
    }
  };
  const onNav = (f: ReturnType<Page['mainFrame']>) => {
    if (f === main()) enforcer.observe({ url: f.url() });
  };
  const onLoad = () => {
    void i.reader.bodyText().then((text) => enforcer.observe({ text }), () => {});
  };
  const onResponse = (r: Response) => {
    if (!portal(r.url())) return;
    const req = r.request();
    enforcer.observeStatus(r.status(), req.resourceType() === 'document' && req.frame() === main());
    // 홈택스 점검(2026-11-14 실화면 run-1dcc8294): 최상위 주소·화면 글은 그대로고, WebSquare 화면 XML 요청만 307로 /info_page.html에 간다.
    // 그 응답이 오면 주소 신호로 보고, 본문(안내 글)을 글 신호로 넘겨 끝 시각을 읽게 한다. 본문은 저장하지 않는다.
    if (isInfoPage(r.url())) {
      // 본문을 먼저 읽어 주소와 같이 넘긴다(주소만 먼저 걸리면 실행이 바로 끝나 끝 시각을 못 싣는다). 본문을 못 읽으면 주소만.
      const url = r.url();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 응답 본문(r.text)은 금고 중계로 오지 않았다(가짜 실측: 끝나지 않음). 같은 출처에서 안내 문서를 한 번 더 받아 읽는다(GET, 점검 안내뿐).
      const read = page.mainFrame().evaluate(async (u: string) => (await fetch(u, { credentials: 'omit' })).text(), url).catch(() => null);
      const body = Promise.race([read, new Promise<null>((res) => (timer = setTimeout(() => res(null), INFO_BODY_WAIT_MS)))]);
      void body.then((h) => {
        clearTimeout(timer);
        enforcer.observe(h ? { url, text: htmlText(h) } : { url });
      });
    }
  };
  const onDialog = (d: Dialog) => {
    const kind = d.type() as DialogKind;
    const message = d.message();
    enforcer.observe({ text: message });
    const h: DialogHandle = { kind: DIALOG_KINDS.has(kind) ? kind : 'prompt', message, accept: () => d.accept(), dismiss: () => d.dismiss() };
    void i.actuator.dialog(h).catch(() => d.dismiss().catch(() => {}));
  };
  page.on('framenavigated', onNav);
  page.on('load', onLoad);
  page.on('response', onResponse);
  page.on('dialog', onDialog);
  const onPopup = (p: Page) => {
    void (async () => {
      await p.waitForLoadState('domcontentloaded', { timeout: POPUP_TITLE_WAIT_MS }).catch(() => {});
      const title = normalizeName(await p.title().catch(() => ''));
      if (i.closeWindows!.some((re) => re.test(title))) {
        await p.close().catch(() => {});
        i.journal?.('window.closed', { why: 'closeWindows' });
      } else i.journal?.('window.left_open', {});
    })();
  };
  if (i.closeWindows?.length) page.on('popup', onPopup);
  const off = i.guard && i.vaultOn ? i.vaultOn('commit.body_compared', (d) => i.guard!.onBodyCompared(d as unknown as CommitBodyComparedEvent)) : () => {};
  await i.interceptor?.start();
  let done = false;
  return {
    async dispose() {
      if (done) return;
      done = true;
      page.off('framenavigated', onNav);
      page.off('load', onLoad);
      page.off('response', onResponse);
      page.off('dialog', onDialog);
      page.off('popup', onPopup);
      off();
      await i.guard?.disarm();
      await i.interceptor?.stop();
    },
  };
}

/** 점검 안내 본문을 기다리는 상한(ms). 못 받으면 주소 신호만 건다(끝 시각 없음). */
const INFO_BODY_WAIT_MS = 1_500;

/** 포털 점검 안내 문서(/info_page.html)인가(경로만 본다). */
function isInfoPage(url: string): boolean {
  try {
    return new URL(url).pathname === '/info_page.html';
  } catch {
    return false;
  }
}

/** HTML → 글(스크립트·스타일 빼고 태그 지움, 공백 접기). 신호 사전 대조·점검 끝 시각 읽기에만 쓴다. */
function htmlText(h: string): string {
  return h
    .slice(0, 200_000)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
