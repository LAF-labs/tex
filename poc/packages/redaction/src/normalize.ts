/**
 * 검출용 공통 정규화(D06 §2, N-35): NFKC + 보이지 않는 문자(Default_Ignorable·서식 문자 Cf: 소프트 하이픈·방향 표시·결합 문자
 * 결합 방지·이체 선택자·제로폭 등) 제거. 마스킹·egress 트립와이어·인젝션 사전 필터·차단 신호 사전이 모두 이 함수를 쓴다.
 * 출력도 정규화된 텍스트다(색인을 되짚지 않는다).
 */
export function normalizeForDetection(s: string): string {
  return s.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '');
}

/** 마스킹용 정규화: 검출 정규화 + 대시류(‐‑‒–—―−)를 `-`로 통일(D06 §4 정규화 먼저). */
export function normalizeForRedaction(s: string): string {
  return normalizeForDetection(s).replace(/[‐-―−﹘﹣－]/g, '-');
}

/** UTF-8 바이트 수(Buffer 없이 센다: 폰에서도 같은 값). 짝 없는 서로게이트는 U+FFFD(3바이트)로 센다(Node의 바이트 수 계산과 같다. 시험이 대조한다). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
