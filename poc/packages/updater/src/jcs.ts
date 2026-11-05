// JCS(RFC 8785) 직렬화. 서명 바이트 규약 정본은 design/schemas/SIGNING.md §1(엔진 core/canon.ts와 같은 규칙).
// 엔진 canon이 main에 들어오면 그쪽을 쓰고 이 파일은 지운다. 업데이터는 엔진에 기대지 않게 지금은 따로 둔다.

/** RFC 8785: 키는 UTF-16 코드 단위 순, 공백 없음, 숫자·문자열은 ECMAScript JSON 직렬화(소수 허용). 유한하지 않은 수·undefined 값·함수는 던진다. */
export function jcs(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('jcs.non_finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (o[k] === undefined) throw new TypeError('jcs.undefined');
      parts.push(`${JSON.stringify(k)}:${jcs(o[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError('jcs.unsupported');
}
