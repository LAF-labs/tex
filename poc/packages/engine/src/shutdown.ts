
export interface ShutdownProc {
  once(ev: 'SIGTERM', fn: () => void): unknown;
  on(ev: 'exit', fn: () => void): unknown;
  exit(code: number): void;
}

/** close를 한 번만 부르는 종료 처리기를 건다. close가 던져도 나간다(로그·화면 값은 남기지 않는다). 돌려준 함수는 직접 닫을 때 쓴다. */
export function closeOnShutdown(close: () => void, proc: ShutdownProc = process as unknown as ShutdownProc): () => void {
  let closed = false;
  const once = (): void => {
    if (closed) return;
    closed = true;
    try {
      close();
    } catch {
      // 이미 닫혔거나 진행 중 문장이 있다. 프로세스가 끝나면 SQLite가 정리한다.
    }
  };
  proc.on('exit', once);
  proc.once('SIGTERM', () => {
    once();
    proc.exit(0);
  });
  return once;
}
