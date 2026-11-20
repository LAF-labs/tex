import fs from 'node:fs';
import path from 'node:path';
import { DaemonScheduler, emptyDaemonState, notificationText, type DaemonClock, type DaemonNotification, type DaemonSnapshot, type DaemonState, type DaemonStateStore, type TickResult, type TimerPort } from '@sax/daemon';

export type EngineRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type ShowNotification = (text: { title: string; body: string }, onClick: () => void) => void;
type DaemonLog = (name: string, data?: Record<string, string | number | boolean>) => void;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDayMap = (v: unknown) => isObj(v) && Object.values(v).every((d) => typeof d === 'string');

export class FileDaemonStateStore implements DaemonStateStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  load(): DaemonState | null {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!isObj(s) || s.v !== 1 || !(s.lastSeenAt === null || typeof s.lastSeenAt === 'number')) return null;
      if (!isDayMap(s.delivered) || !isDayMap(s.subjectDay) || !isObj(s.dayCount) || !isObj(s.failures)) return null;
      return { ...emptyDaemonState(), ...(s as unknown as DaemonState) };
    } catch {
      return null;
    }
  }
  save(s: DaemonState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, this.file);
  }
}

interface DaemonHostOptions {
  rpc: EngineRpc;
  show: ShowNotification;
  onDelivered?: (n: DaemonNotification) => void;
  onOpen?: (n: DaemonNotification) => void;
  stateFile: string;
  log?: DaemonLog;
  clock?: DaemonClock;
  timers?: TimerPort;
}

export interface DaemonHost {
  scheduler: DaemonScheduler;
  tick(): Promise<TickResult>;
  requestReload(): void;
  stop(): void;
}

export function startDaemonHost(o: DaemonHostOptions): DaemonHost {
  const log = o.log ?? (() => {});
  const source = {
    async snapshot(): Promise<DaemonSnapshot> {
      const s = await o.rpc('daemon.snapshot', {});
      if (!isObj(s) || !Array.isArray(s.profiles)) throw new Error('daemon.snapshot_shape');
      return s as unknown as DaemonSnapshot;
    },
  };
  const sink = {
    deliver(n: DaemonNotification): void {
      o.show(notificationText(n), () => o.onOpen?.(n));
      log('main.daemon_notified', { kind: n.kind });
      o.onDelivered?.(n);
    },
  };
  const scheduler = new DaemonScheduler({ clock: o.clock ?? { now: () => Date.now() }, source, sink, store: new FileDaemonStateStore(o.stateFile) });
  let lastCause: string | null = null;
  const tick = async () => {
    const r = await scheduler.tick();
    if (r.cause !== lastCause) {
      lastCause = r.cause;
      if (r.cause) log(r.cause);
    }
    return r;
  };
  const timers = o.timers ?? { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
  const stopTicks = scheduler.start({ setInterval: (_f, ms) => timers.setInterval(() => void tick(), ms), clearInterval: (h) => timers.clearInterval(h) });
  return { scheduler, tick, requestReload: () => scheduler.requestReload(), stop: stopTicks };
}
