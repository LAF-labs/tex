// 실행 탭 이벤트 배선(M2-4 D): Playwright·금고 이벤트 → 집행기·대화상자 정책·커밋 가드.
// - 주 프레임 네비게이션 → RunEnforcer.observe({url}), load 뒤 본문 → observe({text})(문구는 저장하지 않는다)
// - 포털 호스트 응답 → observeStatus(status, document)
// - 대화상자 → RunEnforcer.observe({text}) 뒤 GuardedActuator.dialog(정책대로 수락·거부)
// - 금고 commit.body_compared → CommitGuard.onBodyCompared, 가드 정지 → RunEnforcer.haltFor(가드 생성 때 stop에 넘긴다)
// - FetchInterceptor 시작·정지, 끝나면 가드 해제(run.end·Chrome 재기동)
import type { Dialog, Page, Response } from 'playwright-core';
import type { DialogHandle, GuardedActuator } from '../core/actuator.ts';
import type { DialogKind } from '../core/dialog.ts';
import { hostAllowed } from '../core/validate.ts';
import type { FetchInterceptor } from '../commitguard/cdp.ts';
import type { CommitGuard } from '../commitguard/guard.ts';
import type { CommitBodyComparedEvent } from '../commitguard/rc1.ts';
import type { RunEnforcer } from '../enforcer.ts';
import type { PageReader } from '../core/page.ts';

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
      off();
      await i.guard?.disarm();
      await i.interceptor?.stop();
    },
  };
}
