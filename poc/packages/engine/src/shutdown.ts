// 엔진 프로세스가 끝날 때 원장 DB를 닫는다(D07 §1.3 DB 유일 소유자).
// main은 EngineHost.shutdown에서 utilityProcess.kill()을 부른다. POSIX에서 이것은 SIGTERM이고, 기본 동작은 'exit' 처리기 없이 끝나는 것이다.
// 그래서 SIGTERM을 받아 닫고 나간다. 닫으면 WAL이 체크포인트되고 -wal·-shm이 지워진다(앱 폴더 삭제·백업이 열린 파일을 만나지 않는다).
// Windows의 kill은 강제 종료라 처리기가 돌지 않는다. 그때도 원장은 synchronous=FULL이라 커밋한 행은 남는다(R-G7).

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
