// P-06 연결 상태: PC 켜짐·꺼짐, 마지막 접속, 페어링, PC로 아직 못 보낸 사진·현금매출 건수.
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { sp1Report, type Sp1Report } from '../diag';
import { identityLines } from '../pairing/identity';
import { resetDevice } from '../keyring';
import { useSession } from '../session';
import { space } from '../theme';
import { Button, Card, Screen, T, ago } from '../ui/kit';

function Row({ k, v, testID }: { k: string; v: string; testID?: string }) {
  return (
    <View style={st.row}>
      <T v="label" c="ink3" style={{ width: 96 }}>
        {k}
      </T>
      <T v="body" testID={testID} style={{ flex: 1 }}>
        {v}
      </T>
    </View>
  );
}

export function ConnectionScreen({ onDone, onReset, onRepair }: { onDone: () => void; onReset: () => void; onRepair: () => void }) {
  const s = useSession();
  const pair = s.data.pair;
  const [sp1, setSp1] = useState<Sp1Report | null>(null);
  const state =
    s.pc === 'online'
      ? '켜짐'
      : s.pc === 'connecting'
        ? '찾는 중'
        : s.pc === 'unpaired'
          ? '연결 전'
          : s.pc === 'queued'
            ? '꺼짐 · 릴레이에 암호화해 맡김(24시간, PC가 켜지면 받음)'
            : s.pc === 'stale'
              ? 'PC와 연결을 확인할 수 없어요. PC를 켜 두거나 다시 연결하세요.'
              : '꺼짐 또는 응답 없음';
  const certDays = pair ? Math.floor((pair.certNotAfter - Date.now()) / 86_400_000) : 0;
  return (
    <Screen>
      <View style={st.pad} testID="connection-screen">
        <T v="title">PC 연결</T>
        <Card>
          <Row k="PC" v={state} testID="conn-state" />
          <Row k="마지막 접속" v={ago(s.data.lastSeenPc)} />
          {pair && <Row k="계정" v={identityLines({ accountEmail: pair.accountEmail ?? null, desktopName: null }).account} testID="conn-account" />}
          {pair && <Row k="PC가 알려 준 이름" v={identityLines({ accountEmail: null, desktopName: pair.desktopName ?? null }).pc} testID="conn-pc-name" />}
          {pair && <Row k="연결한 날" v={new Date(pair.pairedAt).toLocaleDateString('ko-KR')} />}
          {pair && <Row k="PC 기기" v={`…${pair.desktopDeviceId.slice(-6)}`} />}
          {pair && <Row k="인증서" v={certDays > 0 ? `${certDays}일 남음(PC가 켜지면 갱신)` : '만료 — PC와 다시 연결'} />}
          <Row k="보낼 것" v={`사진 ${s.pending.receipts}장 · 현금매출 ${s.pending.cash}건`} testID="conn-pending" />
        </Card>
        {pair && <Button label="지금 보내기" onPress={() => void s.sync()} busy={s.syncing} />}
        {pair && s.pc === 'stale' && <Button testID="re-pair" kind="secondary" label="다시 연결하기" onPress={onRepair} />}
        <Button kind="secondary" label="닫기" onPress={onDone} />
        <Button testID="sp1" kind="quiet" label="이 폰 보호 상태 보기" onPress={async () => setSp1(await sp1Report())} />
        {sp1 && (
          <Card>
            <T v="label" c={sp1.ok ? 'accent' : 'attention'} testID="sp1-result">
              {sp1.ok ? '열쇠·파일 보호 정상' : '보호가 약한 항목이 있어요'}
            </T>
            <T v="caption" c="ink3">
              열쇠: {sp1.keychain.accessible} · 생체 {sp1.keychain.biometric ? '필요' : '없음(시뮬레이터 개발)'}
            </T>
            {sp1.files.slice(0, 8).map((f) => (
              <T key={f.path} v="caption" c={f.excludedFromBackup ? 'ink3' : 'attention'}>
                {f.path} · 백업 {f.excludedFromBackup ? '제외' : '포함'} · {f.protection}
              </T>
            ))}
          </Card>
        )}
        {pair && (
          <Button
            kind="danger"
            label="이 폰 연결 해제"
            onPress={() =>
              Alert.alert('이 폰 연결 해제', '이 폰의 열쇠와 보내지 않은 사진·현금매출을 지워요. PC의 기기 목록에서도 이 폰을 해제해 주세요.', [
                { text: '취소', style: 'cancel' },
                {
                  text: '해제',
                  style: 'destructive',
                  onPress: async () => {
                    await resetDevice();
                    onReset();
                  },
                },
              ])
            }
          />
        )}
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  pad: { padding: space.s5, gap: space.s4 },
  row: { flexDirection: 'row', gap: space.s3, alignItems: 'flex-start' },
});
