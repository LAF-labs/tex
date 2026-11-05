// design-system v1.2 tokens.json에서 폰에 쓰는 색·간격만 옮겼다(승인 바 팔레트처럼 앱 내장, ADR-028 결정 7의 취지).
import { useColorScheme } from 'react-native';

const light = {
  canvas: '#F5F6F7', surface: '#FFFFFF', sunken: '#EEF0F2', tint: '#F0F2F4', line: '#E4E7EB', lineStrong: '#878E97',
  ink: '#16191D', ink2: '#4F5661', ink3: '#646B76', ink4: '#9AA1AA', onInk: '#FFFFFF',
  accent: '#2A4F9E', accentSoft: '#E8EEF9', accentStrong: '#1F3F86', onAccent: '#FFFFFF',
  attention: '#8A5A0B', attentionSoft: '#F8EEDC', scrim: '#16191D52',
};
const dark: typeof light = {
  canvas: '#101215', surface: '#171A1E', sunken: '#0B0D10', tint: '#20252B', line: '#272B31', lineStrong: '#6B737D',
  ink: '#E9EBEE', ink2: '#A9B0B9', ink3: '#8B939D', ink4: '#5C636C', onInk: '#101215',
  accent: '#8EAAF0', accentSoft: '#1B2540', accentStrong: '#A3BBF4', onAccent: '#0B1226',
  attention: '#E0AE55', attentionSoft: '#2E2410', scrim: '#00000080',
};
export type Palette = typeof light;

export const space = { s0: 2, s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32 } as const;
export const radius = { sm: 6, md: 8, lg: 12, xl: 16, full: 9999 } as const;
export const type = {
  figure: { fontSize: 28, lineHeight: 34, fontWeight: '600' as const, fontVariant: ['tabular-nums' as const] },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  sas: { fontSize: 44, lineHeight: 52, fontWeight: '600' as const, fontVariant: ['tabular-nums' as const], letterSpacing: 6 },
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}
