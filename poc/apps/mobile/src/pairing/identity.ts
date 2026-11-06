// 페어링 저장 전 확인 화면(설계 #120)과 연결 화면에 보일 문구. 이메일은 계정 서비스 서명(acct_claim)을 검증한 값을 전체로 보인다.
// PC 이름은 PC가 스스로 알린 값이라 "PC가 알려 준 이름"으로 참고 표시만 한다.

export function identityLines(i: { accountEmail: string | null; desktopName: string | null }): { account: string; pc: string } {
  return { account: i.accountEmail ?? '계정 정보 없음', pc: i.desktopName ?? '알려 준 이름 없음' };
}
