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
