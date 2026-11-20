import { createHash } from 'node:crypto';

export interface CommitArmParams {
  runId: string;
  intentId: string;
  stepId: string;
  targetId: string;
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
