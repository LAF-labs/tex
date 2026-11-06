// decide 화면 관측의 Playwright 구현(M2-2 B): scope('root' 또는 셀렉터 사전 키)의 aria 스냅숏 → A11yNode 트리.
// 읽기 전용이다. scope 키는 R-A1(역할·이름 동일성)을 지난 요소만 쓰고, 찾지 못하거나 모호하면 null(호출 측 portal.unobservable).
import type { Page } from 'playwright-core';
import { nameMatches, resolveTarget } from '../core/resolve.ts';
import { isSecretEntry, type SelectorDict } from '../core/types.ts';
import type { ScreenCapture, ScreenSource } from '../run/decide.ts';
import { ariaToTree } from './aria-tree.ts';
import type { PlaywrightPageReader } from './reader.ts';

export class PlaywrightScreenSource implements ScreenSource {
  private readonly page: Page;
  private readonly reader: PlaywrightPageReader;
  private readonly dict: SelectorDict;
  private readonly secretPatterns: string[];

  constructor(i: { page: Page; reader: PlaywrightPageReader; dict: SelectorDict }) {
    this.page = i.page;
    this.reader = i.reader;
    this.dict = i.dict;
    this.secretPatterns = Object.values(i.dict.entries)
      .filter((e) => isSecretEntry(e))
      .map((e) => e.namePattern);
  }

  async capture(scope: string): Promise<ScreenCapture | null> {
    let snap: string | null;
    if (scope === 'root') snap = await this.reader.ariaSnapshot(null);
    else {
      const r = await resolveTarget(this.reader, this.dict, scope);
      if (!r.ok) return null;
      snap = await this.reader.ariaSnapshot(r.t.el);
    }
    if (snap === null) return null;
    const isSecret = (name: string) => this.secretPatterns.some((p) => nameMatches(p, name));
    const tree = ariaToTree(snap, { isSecret });
    if (scope !== 'root') {
      // 스냅숏 첫 노드가 scope 요소 자신이다.
      const first = tree.children?.[0];
      if (!first || (tree.children?.length ?? 0) !== 1) return null;
      first.scopeId = scope;
    }
    const title = await this.page.title().catch(() => '');
    return { url: this.page.url(), title, tree };
  }
}
