// 잠금이 풀린 동안의 앱 상태: 메모리 키, 봉인된 상태 파일, 보관함, PC 연결. 잠그면 통째로 버린다(P-01).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { RECONNECT_MS } from './config';
import type { DeviceKeys } from './keyring';
import { syncWithPc, type PcStatus } from './net/pc';
import { FileOutbox } from './storage/outbox';
import { saveData, type AppData } from './storage/state';

export interface Session {
  keys: DeviceKeys;
  data: AppData;
  outbox: FileOutbox;
  pending: { receipts: number; cash: number };
  pc: PcStatus;
  syncing: boolean;
  update: (f: (d: AppData) => AppData) => Promise<void>;
  sync: () => Promise<void>;
  refreshPending: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('session: locked');
  return s;
}

export function SessionProvider({ keys, initial, children }: { keys: DeviceKeys; initial: AppData; children: ReactNode }) {
  const [data, setData] = useState(initial);
  const dataRef = useRef(initial);
  const outbox = useMemo(() => new FileOutbox(keys.fileKey), [keys]);
  const [pending, setPending] = useState({ receipts: 0, cash: 0 });
  const [pc, setPc] = useState<PcStatus>(initial.pair ? 'offline' : 'unpaired');
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);

  const update = useCallback(
    async (f: (d: AppData) => AppData) => {
      const next = f(dataRef.current);
      dataRef.current = next;
      setData(next);
      await saveData(keys.fileKey, next);
    },
    [keys],
  );

  const refreshPending = useCallback(async () => setPending(await outbox.counts()), [outbox]);

  const sync = useCallback(async () => {
    if (busy.current || !dataRef.current.pair) {
      if (!dataRef.current.pair) setPc('unpaired');
      return;
    }
    busy.current = true;
    setSyncing(true);
    setPc('connecting');
    try {
      const r = await syncWithPc({ keys, data: () => dataRef.current, update, outbox });
      setPc(r.status);
    } finally {
      busy.current = false;
      setSyncing(false);
      await refreshPending();
    }
  }, [keys, update, outbox, refreshPending]);

  useEffect(() => {
    void refreshPending();
    void sync();
    const t = setInterval(() => {
      if (AppState.currentState === 'active') void sync();
    }, RECONNECT_MS);
    return () => clearInterval(t);
  }, [sync, refreshPending]);

  const value = useMemo<Session>(() => ({ keys, data, outbox, pending, pc, syncing, update, sync, refreshPending }), [keys, data, outbox, pending, pc, syncing, update, sync, refreshPending]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
