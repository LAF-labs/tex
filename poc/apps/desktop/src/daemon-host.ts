// 서류 데몬 배선(D10 §3 notify 모드, D14 M4-8). @sax/daemon 스케줄러를 main에서 1분마다 돌리고, 알림은 OS 알림으로 낸다.
// - 원천: 엔진 main 전용 읽기 질의 `daemon.snapshot`(main은 DB 키가 없다). 엔진이 아직 답하지 않으면(M2-5 전) 스케줄러가 백오프하며 아무것도 내지 않는다.
// - 출력: OS 알림(notificationText: 고정 문구 + 숫자·달·서류 종류 이름만) + 이번 달 판 다시 그리기. 누르면 창을 앞으로. 실행 시작은 없다(Phase 1).
// - 억제 기록: userData/daemon-state.json(알림 id·날짜·시각만, 값 없음). 깨졌으면 빈 상태로 시작한다.
// - 절전 복귀·사용자 설정 변경 뒤 requestReload.
import fs from 'node:fs';
import path from 'node:path';
import { DaemonScheduler, emptyDaemonState, notificationText, type DaemonClock, type DaemonNotification, type DaemonSnapshot, type DaemonState, type DaemonStateStore, type TickResult, type TimerPort } from '@sax/daemon';

export type EngineRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** OS 알림 한 건을 띄운다. 띄우지 못하면 던진다(스케줄러가 재시도한다). onClick은 알림을 누를 때. */
export type ShowNotification = (text: { title: string; body: string }, onClick: () => void) => void;
export type DaemonLog = (name: string, data?: Record<string, string | number | boolean>) => void;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDayMap = (v: unknown) => isObj(v) && Object.values(v).every((d) => typeof d === 'string');

/** 억제 기록 파일. 모양이 틀리면 null(빈 상태로 시작). 쓰기는 임시 파일 → 이름 바꾸기. */
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

export interface DaemonHostOptions {
  rpc: EngineRpc;
  show: ShowNotification;
  /** 알림을 낸 뒤(판 다시 그리기) */
  onDelivered?: (n: DaemonNotification) => void;
  /** 알림을 눌렀을 때(창을 앞으로) */
  onOpen?: (n: DaemonNotification) => void;
  stateFile: string;
  log?: DaemonLog;
  clock?: DaemonClock;
  timers?: TimerPort;
}

export interface DaemonHost {
  scheduler: DaemonScheduler;
  /** 지금 한 번 돌린다(시험·기동 직후). */
  tick(): Promise<TickResult>;
  requestReload(): void;
  stop(): void;
}

/** 스케줄러를 만들고 1분 틱을 건다. 엔진 응답은 모양만 보고 넘긴다(스케줄러가 프로필별로 계획한다). */
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
      // 값 없이 종류만(id에는 문서 id가 들어 있을 수 있어 남기지 않는다)
      log('main.daemon_notified', { kind: n.kind });
      o.onDelivered?.(n);
    },
  };
  const scheduler = new DaemonScheduler({ clock: o.clock ?? { now: () => Date.now() }, source, sink, store: new FileDaemonStateStore(o.stateFile) });
  let lastCause: string | null = null;
  const tick = async () => {
    const r = await scheduler.tick();
    // 원인 코드가 바뀔 때만 남긴다(1분마다 같은 줄을 쌓지 않는다)
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
