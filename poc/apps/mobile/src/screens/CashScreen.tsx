// P-09 현금매출 입력: 하루 숫자 하나, 날짜별로 쌓이고, PC cash_sales로 E2EE 전송(cash.entry). 같은 날을 다시 적으면 바꾼다.
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { enqueueCash, makeCashEntry } from '@sax/remote';
import { useSession } from '../session';
import { radius, space, type, usePalette } from '../theme';
import { Button, Card, Notice, Screen, T, won } from '../ui/kit';

export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shift(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + n));
}
const label = (day: string, today: string) => (day === today ? '오늘' : day === shift(today, -1) ? '어제' : day.slice(5).replace('-', '월 ') + '일');

export function CashScreen({ onDone }: { onDone: () => void }) {
  const s = useSession();
  const p = usePalette();
  const today = localDay();
  const [day, setDay] = useState(today);
  const existing = s.data.cash.find((c) => c.day === day);
  const [text, setText] = useState(existing ? String(existing.amount) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (d: string) => {
    setDay(d);
    const e = s.data.cash.find((c) => c.day === d);
    setText(e ? String(e.amount) : '');
    setErr(null);
  };

  async function save() {
    const n = Number(text.replace(/[,\s원]/g, ''));
    if (!text.trim() || !Number.isSafeInteger(n) || n < 0 || n > 100_000_000_000) return setErr('금액을 숫자로 적어 주세요. 현금 매출이 없으면 0을 적어요.');
    setBusy(true);
    try {
      const e = makeCashEntry(day, n);
      await enqueueCash(s.outbox, e);
      await s.update((d) => ({
        ...d,
        cash: [{ day, amount: n, msgId: e.msgId, state: 'pending' as const }, ...d.cash.filter((c) => c.day !== day)].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 400),
      }));
      await s.refreshPending();
      void s.sync();
      onDone();
    } catch {
      setErr('저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  }

  const canNext = day < today;
  const canPrev = day > shift(today, -31);
  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={st.pad} keyboardShouldPersistTaps="handled" testID="cash-screen">
          <T v="title">현금 매출</T>
          <View style={st.dayRow}>
            <Button kind="secondary" label="‹" onPress={() => pick(shift(day, -1))} disabled={!canPrev} style={st.arrow} />
            <T v="label" testID="cash-day">
              {label(day, today)} · {day}
            </T>
            <Button kind="secondary" label="›" onPress={() => pick(shift(day, 1))} disabled={!canNext} style={st.arrow} />
          </View>
          <Card>
            <T v="label" c="ink2">
              {label(day, today)} 현금으로 받은 매출(영수증을 주지 않은 것 포함)
            </T>
            <View style={st.amountRow}>
              <TextInput
                testID="cash-amount"
                value={text}
                onChangeText={setText}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={p.ink4}
                style={[type.figure, st.input, { color: p.ink, borderColor: p.lineStrong, backgroundColor: p.surface }]}
                autoFocus
              />
              <T v="title" c="ink2">
                원
              </T>
            </View>
            <T v="caption" c="ink3">
              PC로 암호화해 보내요. 같은 날을 다시 적으면 새 숫자로 바꿔요.
            </T>
          </Card>
          {err && <Notice>{err}</Notice>}
          <Button testID="cash-save" label="저장하고 PC로 보내기" onPress={save} busy={busy} />
          <Button kind="secondary" label="닫기" onPress={onDone} />
          {s.data.cash.length > 0 && (
            <View style={{ gap: space.s2 }}>
              <T v="label" c="ink2">
                최근 기록
              </T>
              {s.data.cash.slice(0, 14).map((c) => (
                <Pressable key={c.day} onPress={() => pick(c.day)} style={[st.hist, { borderColor: p.line, backgroundColor: p.surface }]}>
                  <T v="body">{c.day}</T>
                  <T v="body" style={{ fontVariant: ['tabular-nums'] }}>
                    {won(c.amount)}
                  </T>
                  <T v="caption" c={c.state === 'sent' ? 'ink3' : 'attention'}>
                    {c.state === 'sent' ? 'PC 받음' : '보낼 예정'}
                  </T>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  pad: { padding: space.s5, gap: space.s4 },
  dayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  arrow: { minHeight: 40, width: 56 },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: space.s2 },
  input: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.s3, paddingVertical: space.s2, textAlign: 'right' },
  hist: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderRadius: radius.md, padding: space.s3 },
});
