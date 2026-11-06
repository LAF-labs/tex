// 금고 R-C1 계약(#81, vault/src/protocol.ts)의 엔진 쪽 사본. 엔진은 @sax/vault에 의존하지 않는다(네이티브 키링을 끌어오지 않게).
// 같은지는 시험(tests/commitguard.test.ts)이 금고 함수와 바로 대조한다.
import { createHash } from 'node:crypto';

export interface CommitArmParams {
  runId: string;
  intentId: string;
  stepId: string;
  targetId: string;
  /** Fetch urlPattern. 스킴·호스트는 와일드카드 없이 고정. */
  endpoint: string;
  method?: string;
  bodyFieldMap: Record<string, string>;
  expectedHash: string;
}
export interface CommitArmResult {
  armed: boolean;
  reason?: 'bad_params' | 'endpoint_not_allowed' | 'target_not_exposed' | 'already_armed';
}
export type CommitMatch = true | false | 'opaque' | 'expired';
export interface CommitBodyComparedEvent {
  intentId: string;
  stepId: string;
  match: CommitMatch;
}
export const COMMIT_ARM_TTL_MS = 120_000;

/** 금고 RPC 중 커밋 가드가 쓰는 것. */
export interface VaultCommitPort {
  arm(p: CommitArmParams): Promise<CommitArmResult>;
  disarm(p: { intentId: string; stepId: string }): Promise<void>;
}

export function normalizeCommitValue(v: string): string {
  return v.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** sha256("SAX-rc1-v1\n" ‖ JSON.stringify([[fieldKey, normalized]...])) hex, 키는 코드 단위 순. */
export function commitExpectedHash(values: Record<string, string>, bodyFieldMap: Record<string, string>): string {
  const pairs = Object.keys(bodyFieldMap)
    .sort()
    .map((k) => {
      const v = values[k];
      if (typeof v !== 'string') throw new Error(`missing field ${k}`);
      return [k, normalizeCommitValue(v)];
    });
  return createHash('sha256').update('SAX-rc1-v1\n' + JSON.stringify(pairs), 'utf8').digest('hex');
}
