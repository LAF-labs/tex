// 사업자등록번호(10자리) 정규화·검증. 가중치 1,3,7,1,3,7,1,3,5 + 9번째 자리 ×5의 십의 자리.
export function normalizeBizNo(input: string): string {
  return input.replace(/\D/g, '');
}

export function isValidBizNo(input: string): boolean {
  const d = normalizeBizNo(input);
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

export function formatBizNo(input: string): string {
  const d = normalizeBizNo(input);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d;
}

/** 테스트용 합성 사업자번호(체크섬 유효, D13 §2). */
export function syntheticBizNo(seed: number): string {
  const base = String(100000000 + ((seed * 7919) % 899999999)).slice(0, 9);
  for (let c = 0; c <= 9; c++) if (isValidBizNo(base + c)) return base + c;
  throw new Error('unreachable');
}
