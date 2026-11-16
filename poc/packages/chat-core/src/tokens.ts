// 토큰 수 추정(폰에는 토크나이저가 없다). 컨텍스트 상한을 지키는 데만 쓴다. 과금은 게이트웨이가 공급사 usage로 센다.
// 작게 잡으면 상한을 넘기므로 넉넉하게 센다. 시험이 BPE 토크나이저와 견줘 "실제보다 작지 않다"를 본다.

/**
 * 추정 토큰 수. 한글 음절과 그 밖의 비ASCII 글자는 1, ASCII 낱말(영문·숫자 묶음)은 4자마다 1(최소 1),
 * 대괄호·중괄호·밑줄은 1(토큰 [NAME_1]·슬롯 {r1.count}은 낱자로 쪼개진다), 그 밖의 ASCII 문장부호와 줄바꿈은 0.5,
 * 공백은 세지 않는다(BPE에서 대개 다음 토큰에 붙는다).
 * o200k 기준 한국어 머리말은 글자당 0.55토큰쯤이라 이 추정은 1.1~1.6배로 넉넉하다. 한국어가 덜 눌리는 토크나이저(DeepSeek)에서도 모자라지 않게 둔 값이다.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  let run = 0;
  const flush = () => {
    if (run) n += Math.ceil(run / 4);
    run = 0;
  };
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      run++;
      continue;
    }
    flush();
    if (c === 0x20 || c === 0x09) continue;
    n += c >= 0x80 || c === 0x5b || c === 0x5d || c === 0x5f || c === 0x7b || c === 0x7d ? 1 : 0.5;
  }
  flush();
  return Math.ceil(n);
}
