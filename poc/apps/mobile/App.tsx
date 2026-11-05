// tex 폰 앱(Phase 1, ADR-034): 잠금(P-01) → 홈 → 연결(S-03)·연결 상태(P-06)·촬영(P-08)·현금매출(P-09).
// 잠금: 앱을 열 때 생체, 백그라운드 30초 뒤 다시 잠그고 메모리 키를 지운다. 앱 전환기 미리보기는 가린다.
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LOCK_AFTER_MS } from './src/config';
import { ensureFreshInstall, forget, type DeviceKeys } from './src/keyring';
import { sweepCaptureTemps } from './src/storage/files';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { CashScreen } from './src/screens/CashScreen';
import { ConnectionScreen } from './src/screens/ConnectionScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LockScreen } from './src/screens/LockScreen';
import { PairScreen } from './src/screens/PairScreen';
import { SessionProvider } from './src/session';
import { emptyData, loadData, type AppData } from './src/storage/state';
import { usePalette } from './src/theme';
import { T } from './src/ui/kit';

type Route = 'home' | 'pair' | 'capture' | 'cash' | 'connection';

export default function App() {
  const p = usePalette();
  const [boot, setBoot] = useState<{ hasDevice: boolean } | null>(null);
  const [unlocked, setUnlocked] = useState<{ keys: DeviceKeys; data: AppData } | null>(null);
  const [route, setRoute] = useState<Route>('home');
  const [cover, setCover] = useState(false);
  const [bootErr, setBootErr] = useState(false);
  const bgAt = useRef<number | null>(null);
  const keysRef = useRef<DeviceKeys | null>(null);

  useEffect(() => {
    sweepCaptureTemps();
    ensureFreshInstall().then(setBoot, () => setBootErr(true));
  }, []);

  const lock = useCallback(() => {
    forget(keysRef.current);
    keysRef.current = null;
    setUnlocked(null);
    setRoute('home');
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        setCover(false);
        if (bgAt.current !== null && Date.now() - bgAt.current >= LOCK_AFTER_MS) lock();
        bgAt.current = null;
      } else {
        setCover(true);
        if (st === 'background' && bgAt.current === null) bgAt.current = Date.now();
      }
    });
    return () => sub.remove();
  }, [lock]);

  const onUnlocked = async (keys: DeviceKeys) => {
    keysRef.current = keys;
    let data = emptyData();
    try {
      data = await loadData(keys.fileKey);
    } catch {
      // 상태 파일 봉인이 깨졌으면 빈 상태로 시작한다(페어링을 다시 한다)
    }
    setBoot({ hasDevice: true });
    setUnlocked({ keys, data });
  };

  let body;
  if (bootErr) body = <View style={st.center}><T c="attention">보호된 저장 공간을 열 수 없어요. 앱을 다시 설치해 주세요.</T></View>;
  else if (!boot) body = <View style={[st.fill, { backgroundColor: p.canvas }]} />;
  else if (!unlocked) body = <LockScreen firstRun={!boot.hasDevice} onUnlocked={(k) => void onUnlocked(k)} onReset={() => setBoot({ hasDevice: false })} />;
  else {
    const home = () => setRoute('home');
    body = (
      <SessionProvider keys={unlocked.keys} initial={unlocked.data}>
        {route === 'home' && <HomeScreen go={setRoute} />}
        {route === 'pair' && <PairScreen onDone={home} />}
        {route === 'capture' && <CaptureScreen onDone={home} />}
        {route === 'cash' && <CashScreen onDone={home} />}
        {route === 'connection' && (
          <ConnectionScreen
            onDone={home}
            onReset={() => {
              lock();
              setBoot({ hasDevice: false });
            }}
          />
        )}
      </SessionProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {body}
      {cover && <View style={[StyleSheet.absoluteFill, { backgroundColor: p.canvas }]} testID="privacy-cover" />}
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
