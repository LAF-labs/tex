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
  vaultOn?: (name: string, fn: (data: Record<string, unknown>) => void) => () => void;
  closeWindows?: readonly RegExp[];
  journal?: (type: string, payload: Record<string, string>) => void;
}

export interface RunWiring {
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
