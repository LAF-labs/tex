// Phase 1 폰 첫 화면(08 §10): 두 버튼 [영수증 찍기] [오늘 현금 매출]과 PC 연결 상태 줄. 줄을 누르면 연결 상태(P-06).
import { Pressable, StyleSheet, View } from 'react-native';
import { useSession } from '../session';
import { space, usePalette } from '../theme';
import { Button, Card, Screen, T, ago } from '../ui/kit';

export function HomeScreen({ go }: { go: (to: 'pair' | 'capture' | 'cash' | 'connection') => void }) {
  const s = useSession();
  const p = usePalette();
  const paired = !!s.data.pair;
  const waiting = s.pending.receipts + s.pending.cash;
  const line =
    s.pc === 'unpaired'
      ? '○ PC와 연결 전'
      : s.pc === 'online'
        ? '● 사무실 PC 켜짐'
        : s.pc === 'connecting'
          ? '◌ PC 찾는 중'
          : s.pc === 'queued'
            ? '◐ PC 꺼짐 · 맡겨 두었어요(PC가 켜지면 받아요)'
            : s.pc === 'stale'
              ? '○ PC가 오래 꺼져 있어 맡길 수 없어요 · PC를 켜 주세요'
              : `○ PC 꺼짐 · ${ago(s.data.lastSeenPc)}`;
  return (
    <Screen>
      <View style={st.wrap}>
        <Pressable testID="pc-status" accessibilityRole="button" onPress={() => go('connection')} style={[st.status, { borderColor: p.line, backgroundColor: p.surface }]}>
          <T v="label" c={s.pc === 'online' ? 'accent' : 'ink2'}>
            {line}
          </T>
          {waiting > 0 && (
            <T v="caption" c="ink3">
              PC로 보낼 것 {waiting}건
            </T>
          )}
        </Pressable>

        {!paired ? (
          <Card>
            <T v="title">PC와 연결해 주세요</T>
            <T c="ink2">PC의 tex 앱에서 [폰 연결]을 누르면 QR이 떠요. 이 폰으로 찍으면 연결돼요.</T>
            <Button testID="go-pair" label="PC와 연결하기" onPress={() => go('pair')} />
          </Card>
        ) : null}

        <View style={{ gap: space.s3 }}>
          <Button testID="go-capture" label="영수증 찍기" onPress={() => go('capture')} disabled={!paired} style={st.big} />
          <Button testID="go-cash" kind="secondary" label="오늘 현금 매출" onPress={() => go('cash')} disabled={!paired} style={st.big} />
          {!paired && (
            <T v="caption" c="ink3">
              PC와 연결한 뒤에 쓸 수 있어요.
            </T>
          )}
        </View>
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, padding: space.s5, gap: space.s5 },
  status: { borderWidth: 1, borderRadius: 9999, paddingVertical: space.s2, paddingHorizontal: space.s4, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  big: { minHeight: 96 },
});
