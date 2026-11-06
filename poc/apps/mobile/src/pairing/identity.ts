// 페어링 저장 전 확인 화면(설계 #120)과 연결 화면에 보여 줄 계정 이메일 가리기. 폰에는 가린 값만 저장한다.
// 예: owner@example.test → ow•••@example.test. 앞 두 글자(한 글자 주소는 한 글자)만 보이고 도메인은 그대로 둔다.

export function maskEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const keep = [...local].slice(0, local.length <= 2 ? 1 : 2).join('');
  return `${keep}•••@${domain}`;
}

/** 화면 문구: 값이 없으면(아직 PC가 보내지 않음) 무엇이 없는지 말한다. */
export function identityLines(i: { desktopName: string | null; accountEmailMasked: string | null }): { pc: string; account: string } {
  return { pc: i.desktopName ?? '이름을 받지 못했어요', account: i.accountEmailMasked ?? '계정 정보를 받지 못했어요' };
}
