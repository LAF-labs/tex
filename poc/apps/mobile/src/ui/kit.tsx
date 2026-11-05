// 폰 화면 공통 부품(design-system v1.2 값). 그림자는 떠 있는 것(시트)에만, 카드는 선으로 나눈다.
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, type, usePalette } from '../theme';

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <SafeAreaView style={[{ flex: 1, backgroundColor: p.canvas }, style]}>{children}</SafeAreaView>;
}

type Kind = 'primary' | 'secondary' | 'quiet' | 'danger';
export function Button({ label, onPress, kind = 'primary', disabled, busy, testID, style }: { label: string; onPress: () => void; kind?: Kind; disabled?: boolean; busy?: boolean; testID?: string; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const bg = kind === 'primary' ? p.accent : kind === 'secondary' ? p.surface : 'transparent';
  const fg = kind === 'primary' ? p.onAccent : kind === 'danger' ? p.attention : kind === 'quiet' ? p.accent : p.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? p.lineStrong : 'transparent', opacity: disabled ? 0.45 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[type.label, { color: fg, fontSize: 16 }]}>{label}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[s.card, { backgroundColor: p.surface, borderColor: p.line }, style]}>{children}</View>;
}

export function T({ children, v = 'body', c, style, testID }: { children: ReactNode; v?: keyof typeof type; c?: 'ink' | 'ink2' | 'ink3' | 'accent' | 'attention' | 'onAccent'; style?: StyleProp<TextStyle>; testID?: string }) {
  const p = usePalette();
  return (
    <Text testID={testID} style={[type[v], { color: p[c ?? 'ink'] }, style]}>
      {children}
    </Text>
  );
}

export function Notice({ children, tone = 'attention' }: { children: ReactNode; tone?: 'attention' | 'accent' }) {
  const p = usePalette();
  return (
    <View style={[s.notice, { backgroundColor: tone === 'attention' ? p.attentionSoft : p.accentSoft }]}>
      <T v="label" c={tone}>
        {children}
      </T>
    </View>
  );
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return '접속 기록 없음';
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

const s = StyleSheet.create({
  btn: { minHeight: 52, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s4 },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.s4, gap: space.s3 },
  notice: { borderRadius: radius.md, paddingVertical: space.s3, paddingHorizontal: space.s4 },
});
