import type { Dialog, Frame, Page, Response } from 'playwright-core';
import { normalizeForDetection } from '@sax/redaction';

// 결정적 차단 신호(D03 §7 (b)(c)(d), C-24). 모델 판정과 독립으로 매 네비게이션·대화상자·응답에서 본다.
// 사전에는 실물 근거가 있는 항목만 둔다. 홈택스 차단·추가 인증·캡차 화면 문구는 공개 근거가 없어(2026-11 리서치,
// reports/PoC-10.md) 비워 두고 PoC-3 실측에서 채운다. 페이지 문구는 저장·기록하지 않고 맞은 항목 id만 넘긴다.

/** busy는 혼잡 대기열(차단 아님): 실행만 멈추고 쿨다운·연속 횟수에 넣지 않는다. */
export type SignalKind = 'block' | 'extra_auth' | 'captcha' | 'busy';

export interface SignalEntry {
  id: string;
  kind: SignalKind;
  /** 주소 전체(href)에 거는 정규식. */
  url?: string;
  /** 본문·대화상자 문구에 들어 있는 문구. NFKC·제로폭 제거·공백 제거 뒤 비교한다. */
  text?: string;
  /** 근거(출처·조회일). */
  source: string;
}

export interface SignalHit {
  kind: SignalKind;
  id: string;
}

const NETFUNNEL = 'hometax.go.kr/js/comm/netfunnel/netfunnel.js(NetFunnel 1.6.11) 대기 팝업 문구, 2026-11-02 원문 대조';
const FIXTURE = '가짜 H-01 페이지(apps/desktop/src/h01-fixture.ts)';

export const SIGNAL_DICT: Record<'hometax' | 'fixture', readonly SignalEntry[]> = {
  hometax: [
    // block·extra_auth·captcha: 근거 있는 문구·URL 없음(TODO(PoC-3) 실측). 응답 상태는 HTTP_RULES가 본다.
    { id: 'hometax.netfunnel.wait', kind: 'busy', text: '접속대기 중입니다', source: NETFUNNEL },
    { id: 'hometax.netfunnel.retry', kind: 'busy', text: '재접속하시면 대기시간이 더 길어집니다', source: NETFUNNEL },
  ],
  fixture: [
    { id: 'fixture.block.url', kind: 'block', url: '/notice/blocked(?:[?#]|$)', source: FIXTURE },
    { id: 'fixture.block.text', kind: 'block', text: '비정상적인 접근이 감지되어 이용이 제한되었습니다', source: FIXTURE },
    { id: 'fixture.extra_auth', kind: 'extra_auth', url: '/auth/extra(?:[?#]|$)', source: FIXTURE },
    { id: 'fixture.captcha', kind: 'captcha', url: '/auth/captcha(?:[?#]|$)', source: FIXTURE },
  ],
};

/**
 * 포털 호스트 응답 상태(D03 §7 (b)). 홈택스 실측 근거는 없다. 429는 HTTP 의미(RFC 6585)로 1회, 차단 페이지가 흔히 쓰는
 * 문서(네비게이션) 403도 1회, 그 밖의 403은 60초에 3회면 차단 신호다. PoC-3에서 조정한다.
 * 관측 한계: 조회 팝업의 첫 문서 응답 이벤트는 금고 중계가 붙기 전에 지나가 보이지 않는다(실측). 그래서 inspect()가
 * 문서의 navigation timing responseStatus로 문서 429·403을 본다(팝업 첫 문서 429를 시험으로 확인).
 */
export const HTTP_RULES = { forbiddenBurst: { count: 3, windowMs: 60_000 } } as const;

const ORDER: readonly SignalKind[] = ['block', 'extra_auth', 'captcha', 'busy'];
const squash = (s: string) => normalizeForDetection(s).replace(/\s+/g, '');

/**
 * \ud654\uba74 \ud655\uc778 \uc2dd(I-4). \uae08\uace0\ub294 \ube44\ubc00 \ucc3d \uc624\uc5fc \uc0c1\ud0dc\uc5d0\uc11c\ub3c4 \uc774 \uc2dd(SHA-256 712e7330\u2026598944)\ub9cc \uc815\ud655 \uc77c\uce58\ub85c \uba74\uc81c\ud55c\ub2e4.
 * \uae00\uc790 \ud558\ub098\ub77c\ub3c4 \ubc14\uafb8\uba74 \uae08\uace0 \uba74\uc81c \ubaa9\ub85d\uacfc \ud568\uaed8 \ubc14\uafd4\uc57c \ud55c\ub2e4. innerText\ub294 \uc785\ub825 \uce78 \uac12\uc744 \ub2f4\uc9c0 \uc54a\ub294\ub2e4.
 */
export const SIGNAL_INSPECT_EXPR = "(() => ({ text: document.body ? document.body.innerText : '', status: ((performance.getEntriesByType('navigation')[0] || {}).responseStatus) || 0 }))()";

/** \uae08\uace0 \uc911\uacc4 \uac70\ubd80 \uba54\uc2dc\uc9c0(I-5). \ube44\ubc00 \ucc3d \ub54c\ubb38\uc5d0 \ud654\uba74\uc744 \ubcfc \uc218 \uc5c6\uc5c8\ub2e4\ub294 \ub73b\uc774\ub2e4(\ud0c0\uc784\uc544\uc6c3\u00b7\ube48 \ud654\uba74\uacfc \ub2e4\ub974\ub2e4). */
const RELAY_DENIED = /vault relay denied \S+ \((secret_window_(?:active|tainted))\)/;
export type InspectUnavailable = 'secret_window_active' | 'secret_window_tainted';

/**
 * 신호 사전 또는 그 사전을 지금 돌려주는 함수. 함수면 검사할 때마다 부른다(받은 정책의 blockSignalsAdd는 다음 차단 신호 검사부터,
 * D03 §7.1 조회와 적용). 부르는 쪽(RunService)이 커밋 구간에는 실행 시작 때의 사전을 돌려준다.
 */
export type SignalDict = readonly SignalEntry[] | (() => readonly SignalEntry[]);

/** 가장 무거운 신호 하나(block > extra_auth > captcha > busy). */
export function matchSignal(source: SignalDict, where: { url?: string; text?: string }): SignalHit | null {
  const dict = typeof source === 'function' ? source() : source;
  const text = where.text ? squash(where.text) : '';
  let best: SignalEntry | null = null;
  for (const e of dict) {
    const hit = (e.url !== undefined && where.url !== undefined && new RegExp(e.url).test(where.url)) || (e.text !== undefined && text !== '' && text.includes(squash(e.text)));
    if (hit && (!best || ORDER.indexOf(e.kind) < ORDER.indexOf(best.kind))) best = e;
  }
  return best && { kind: best.kind, id: best.id };
}

export interface WatchOptions {
  dict: SignalDict;
  /** 포털 호스트(응답 상태·네비게이션 수를 셀 대상). */
  portalHost: (hostname: string) => boolean;
  onHit: (h: SignalHit) => void;
  /** 대화상자 응답은 부르는 쪽(Actuator)이 한다. 문구는 그 전에 본다. */
  onDialog: (d: Dialog) => void;
  /** 단조 시각(403 창). */
  mono: () => number;
  /** 금고가 화면 확인 식을 거부했다(비밀 창 활성·오염). 부르는 쪽이 fail-closed로 판단한다. */
  onUnavailable?: (reason: InspectUnavailable) => void;
}

/**
 * 실행 탭(과 그 팝업)을 지켜본다: 모든 프레임의 네비게이션 URL, 본문 로드 때 프레임별 innerText, 대화상자 문구, 포털 응답 상태.
 * 네비게이션 없이 뜨는 안내(XHR로 그린 레이어)는 부르는 쪽이 동작마다 inspect()로 본다.
 * 한계: 금고 중계가 엔진에 노출하지 않는 프레임(허용 origin 밖)은 볼 수 없다.
 */
export class SignalWatch {
  private readonly o: WatchOptions;
  private readonly pending = new Set<Promise<void>>();
  private readonly off: Array<() => void> = [];
  private readonly forbidden: number[] = [];

  constructor(page: Page, o: WatchOptions) {
    this.o = o;
    this.attach(page);
    const ctx = page.context();
    const onResponse = (r: Response) => this.response(r);
    ctx.on('response', onResponse);
    this.off.push(() => ctx.off('response', onResponse));
  }

  private attach(p: Page): void {
    const onNav = (f: Frame) => this.hit({ url: f.url() });
    const onDom = () => this.track(this.inspect(p));
    const onDialog = (d: Dialog) => {
      const text = d.message();
      this.o.onDialog(d); // 먼저 답한다(열린 대화상자는 페이지를 멈춘다)
      this.hit({ text });
    };
    const onPopup = (q: Page) => {
      this.attach(q);
      this.hit({ url: q.url() });
    };
    p.on('framenavigated', onNav);
    p.on('domcontentloaded', onDom);
    p.on('dialog', onDialog);
    p.on('popup', onPopup);
    this.off.push(() => {
      p.off('framenavigated', onNav);
      p.off('domcontentloaded', onDom);
      p.off('dialog', onDialog);
      p.off('popup', onPopup);
    });
  }

  private portal(url: string): boolean {
    try {
      return this.o.portalHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  /** Playwright 리스너 안에서 부르므로 던지지 않는다. */
  private hit(where: { url?: string; text?: string }): void {
    try {
      const h = matchSignal(this.o.dict, where);
      if (h) this.o.onHit(h);
    } catch {
      // onHit은 걸쇠를 먼저 걸고 기록한다(policy.ts). 여기서 삼키는 것은 기록 실패뿐이다.
    }
  }

  /** 포털 문서·요청의 HTTP 상태(HTTP_RULES). */
  private httpStatus(url: string, s: number, document: boolean): void {
    if (!this.portal(url)) return;
    if (s === 429) return this.o.onHit({ kind: 'block', id: 'http.429' });
    if (s !== 403) return;
    if (document) return this.o.onHit({ kind: 'block', id: 'http.403_document' });
    const t = this.o.mono();
    const { count, windowMs } = HTTP_RULES.forbiddenBurst;
    this.forbidden.push(t);
    while (this.forbidden[0]! <= t - windowMs) this.forbidden.shift();
    if (this.forbidden.length >= count) this.o.onHit({ kind: 'block', id: 'http.403_burst' });
  }

  private unavailable(reason: InspectUnavailable): void {
    try {
      this.o.onUnavailable?.(reason);
    } catch {
      // 기록 실패는 넘긴다(판단은 부르는 쪽 플래그로 한다)
    }
  }

  private track(p: Promise<void>): void {
    const q: Promise<void> = p.catch(() => {}).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  private response(r: Response): void {
    try {
      this.httpStatus(r.url(), r.status(), r.request().isNavigationRequest());
    } catch {
      // 리스너 밖으로 새지 않게
    }
  }

  /**
   * 지금 화면의 프레임별 URL·본문(보이는 글자)·문서 응답 상태(navigation timing responseStatus)를 본다. 문서 상태는
   * 응답 이벤트가 보이지 않는 조회 팝업의 첫 문서용이다. 3초 안에 못 읽은 프레임은 넘긴다(URL은 이미 봤다).
   */
  async inspect(p: Page): Promise<void> {
    if (p.isClosed()) return;
    const frames = p.frames();
    for (const f of frames) this.hit({ url: f.url() });
    const empty = { text: '', status: 0 };
    const seen = await Promise.all(
      frames.map((f) =>
        Promise.race([
          f.evaluate<typeof empty>(SIGNAL_INSPECT_EXPR).catch((e: unknown) => {
            const m = RELAY_DENIED.exec(String((e as Error)?.message ?? ''));
            if (m) this.unavailable(m[1] as InspectUnavailable);
            return empty;
          }),
          new Promise<typeof empty>((r) => setTimeout(() => r(empty), 3_000).unref()),
        ]),
      ),
    );
    seen.forEach((v, i) => {
      this.hit({ text: v.text.slice(0, 200_000) });
      try {
        this.httpStatus(frames[i]!.url(), v.status, true);
      } catch {
        // 위와 같다
      }
    });
  }

  /**
   * 지금 진행 중인 화면 확인이 끝날 때까지. 그 뒤 새로 시작된 확인은 기다리지 않는다(새로고침·리다이렉트가 이어지는
   * 화면에서도 끝나야 한다). 각 확인은 프레임당 3초로 끝이 있다.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  detach(): void {
    for (const f of this.off.splice(0)) f();
  }
}
