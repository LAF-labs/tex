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

  methods(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort(([a], [b]) => a.localeCompare(b)));
  }

  scan(secrets: string[]): LeakFinding[] {
    return this.cap.scan(secrets);
  }
}
