// 잠금과 진행 중 작업(P-01). 잠글 때 메모리 키를 바로 0으로 지우면, 아직 도는 저장·전송이 0 키로 봉인해
// 상태 파일과 보관함을 다음 잠금 해제 때 열 수 없게 만든다. 그래서
//  1) 키를 쓰는 작업은 inflight()로 감싸고, 잠글 때 drained()로 끝나기를 기다린 뒤 지운다(최대 LOCK_DRAIN_MS).
//  2) 그래도 지운 뒤에 깨어난 작업은 liveKey()가 막는다(0 키로는 봉인하지 않고 실패한다).
//  3) 기다림이 끝나면 세대(epoch)를 넘긴다. 지난 세대에 봉인해 둔 쓰기는 파일에 닿기 전에 버린다(sameEpoch).
//     다시 잠금을 풀 때는 이 정리가 끝난 뒤에 상태 파일을 읽는다(새 세션이 옛 쓰기와 겹치지 않게).

let running = 0;
let waiters: (() => void)[] = [];

export async function inflight<T>(f: () => Promise<T>): Promise<T> {
  running++;
  try {
    return await f();
  } finally {
    if (--running === 0) for (const w of waiters.splice(0)) w();
  }
}

/** 진행 중 작업이 모두 끝나거나 maxMs가 지나면 풀린다. */
export function drained(maxMs: number): Promise<void> {
  if (running === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      waiters = waiters.filter((w) => w !== done);
      resolve();
    };
    const t = setTimeout(done, maxMs);
    waiters.push(done);
  });
}

let epoch = 0;
export const currentEpoch = (): number => epoch;
/** 잠금 정리가 끝났을 때 부른다. */
export function endEpoch(): void {
  epoch++;
}
/** 시작한 세대가 지났으면 던진다. 파일에 쓰기 직전에 부른다. */
export function sameEpoch(e: number): void {
  if (e !== epoch) throw new Error('locked');
}

/** 지운(0으로 채운) 키면 던진다. 봉인 직전에 부른다. */
export function liveKey(k: Uint8Array): Uint8Array {
  let acc = 0;
  for (const b of k) acc |= b;
  if (acc === 0) throw new Error('locked');
  return k;
}
