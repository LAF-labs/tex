// P-01 잠금: 앱을 열 때 생체 인증, 백그라운드 30초 뒤 다시 잠금. 해제 = 생체로 보호된 키 항목 읽기(keyring.unlock).
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyringError, createDevice, resetDevice, unlock, type DeviceKeys, type KeyringErrorCode } from '../keyring';
import { space } from '../theme';
import { Button, Notice, Screen, T } from '../ui/kit';

const MESSAGES: Record<KeyringErrorCode, string> = {
  cancelled: '확인을 취소했어요. 다시 열려면 아래를 눌러 주세요.',
  passcode_required: '이 폰에 화면 잠금(암호)을 켜야 쓸 수 있어요. 설정에서 켠 뒤 다시 열어 주세요.',
  biometry_required: '얼굴이나 지문을 이 폰에 등록해야 쓸 수 있어요.',
  corrupt: '이 폰의 열쇠를 찾을 수 없어요. 초기화한 뒤 PC와 다시 연결해 주세요.',
  unavailable: '열쇠 저장소를 열 수 없어요. 잠시 뒤 다시 해 주세요.',
};

export function LockScreen({ firstRun, onUnlocked }: { firstRun: boolean; onUnlocked: (k: DeviceKeys, created: boolean) => void }) {
  const [err, setErr] = useState<KeyringErrorCode | null>(null);
  // 개발 빌드만 원인 문구를 함께 보인다(값·키는 들어 있지 않다)
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (firstRun) onUnlocked(await createDevice(), true);
      else onUnlocked(await unlock(), false);
    } catch (e) {
      setErr(e instanceof KeyringError ? e.code : 'unavailable');
      if (__DEV__) setDetail(String((e as Error)?.message ?? e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!firstRun) void open();
    // 처음 한 번만 자동으로 묻는다
  }, []);

  return (
    <Screen>
      <View style={st.wrap} testID="lock-screen">
        <View style={{ gap: space.s2 }}>
          <T v="title">tex</T>
          {firstRun ? (
            <>
              <T c="ink2">이 폰에만 있는 열쇠를 만들어요.</T>
              <T v="caption" c="ink3">
                열쇠는 이 폰 밖으로 나가지 않고 백업되지 않아요. 서버도 열쇠를 갖지 않아요. 앱을 열 때마다 얼굴·지문으로 확인해요.
              </T>
            </>
          ) : (
            <T c="ink2">얼굴·지문으로 열어요.</T>
          )}
        </View>
        {err && <Notice>{MESSAGES[err]}</Notice>}
        {err && detail && <T v="caption" c="ink3">{detail}</T>}
        <View style={{ gap: space.s2 }}>
          <Button testID="unlock" label={firstRun ? '시작하기' : '열기'} onPress={open} busy={busy} />
          {err === 'corrupt' && (
            <Button
              kind="danger"
              label="이 폰 초기화"
              onPress={async () => {
                await resetDevice();
                setErr(null);
              }}
            />
          )}
        </View>
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, padding: space.s5, justifyContent: 'space-between' },
});
