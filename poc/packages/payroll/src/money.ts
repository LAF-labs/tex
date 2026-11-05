// 원 단위 정수 산술(ADR-031 결정 5). 부동소수를 쓰지 않는다: 요율은 백만분율(ppm) 정수, 곱셈은 BigInt, 끝처리는 표마다 정한 규칙으로.

/** 끝처리 규칙. floor_10 = 10원 미만 절사, round_1 = 원 미만 반올림(0.5 올림) */
export type Rounding = 'floor_1' | 'floor_10' | 'floor_100' | 'floor_1000' | 'round_1' | 'round_10';

export const ROUNDINGS: readonly Rounding[] = ['floor_1', 'floor_10', 'floor_100', 'floor_1000', 'round_1', 'round_10'];

const unitOf = (r: Rounding): bigint => BigInt(r.split('_')[1]!);

/** 유리수 num/den(den > 0, num ≥ 0)을 규칙대로 원 단위 정수로 */
export function roundRational(num: bigint, den: bigint, r: Rounding): number {
  if (den <= 0n || num < 0n) throw new RangeError('rounding_domain');
  const unit = unitOf(r);
  const q = r.startsWith('floor') ? num / (den * unit) : (2n * num + den * unit) / (2n * den * unit);
  return Number(q * unit);
}

export function roundWon(amount: number, r: Rounding): number {
  assertWon(amount);
  return roundRational(BigInt(amount), 1n, r);
}

/** amount × ppm / 1,000,000 을 규칙대로 */
export function applyPpm(amount: number, ppm: number, r: Rounding): number {
  assertWon(amount);
  if (!Number.isSafeInteger(ppm) || ppm < 0) throw new RangeError('invalid_ppm');
  return roundRational(BigInt(amount) * BigInt(ppm), 1_000_000n, r);
}

/** amount × num / den 을 규칙대로 */
export function applyRatio(amount: number, num: number, den: number, r: Rounding): number {
  assertWon(amount);
  return roundRational(BigInt(amount) * BigInt(num), BigInt(den), r);
}

export function assertWon(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('invalid_won');
}

/** 화면·명세서 문장용: 1234567 → "1,234,567원" */
export const won = (n: number): string => `${n.toLocaleString('ko-KR')}원`;

/** 1% = 10,000ppm. 문장용: 47500 → "4.75%" */
export const ppmPct = (ppm: number): string => `${(ppm / 10_000).toString()}%`;
