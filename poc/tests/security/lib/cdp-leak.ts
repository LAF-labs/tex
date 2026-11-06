// CDP 이벤트 누출 탭(D13 §6 "CDP 이벤트 스트림 포함", D14 M5-1). 금고 트랙 @sax/vault leak/scanner(LeakCapture·variantsOf) 재사용.
// 엔진이 받은 이벤트를 메서드별 출처(`cdp:<method>`)로 담아, 어느 이벤트 종류가 비밀(인코딩 변형 포함)을 실었는지 찍는다.
import { LeakCapture, type LeakFinding } from '@sax/vault';

export interface CdpEvent {
  method?: string;
  sessionId?: string;
  params?: unknown;
}

export class CdpLeakTap {
  private readonly cap = new LeakCapture();
  private readonly counts = new Map<string, number>();

  add(ev: CdpEvent): void {
    const m = ev.method ?? '(response)';
    this.counts.set(m, (this.counts.get(m) ?? 0) + 1);
    this.cap.add(`cdp:${m}`, ev);
  }

  addAll(evs: readonly CdpEvent[]): this {
    for (const e of evs) this.add(e);
    return this;
  }

  /** 이벤트 종류별 개수(보고용). */
  methods(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort(([a], [b]) => a.localeCompare(b)));
  }

  scan(secrets: string[]): LeakFinding[] {
    return this.cap.scan(secrets);
  }
}
