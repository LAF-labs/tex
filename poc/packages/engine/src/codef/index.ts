// 계좌 자동조회(CODEF) 엔진 모듈: 클라이언트·거래 줄·연결 서비스와 엔진 안 연결부(설정 저장·금고 봉인·돈 맞추기 저장소 어댑터).
import type { Db } from '@sax/db';
import type { VaultClient } from '../vault-client.ts';
import type { AutoTxnRow } from './rows.ts';
import type { BankTxnSink, CodefLinkStore, CodefSealPort, CodefStoreValue, SealResult } from './link.ts';

export * from './client.ts';
export * from './codes.ts';
export * from './link.ts';
export * from './rows.ts';

/** 엔진 RPC 이름(main → 엔진). 값(번호·비밀번호)은 오가지 않는다 */
export const CODEF_COMMANDS = ['codef.status', 'codef.connect', 'codef.choose', 'codef.refresh', 'codef.cancel', 'codef.disconnect'] as const;

const KEY = 'codef.link';

/** 연결 상태는 엔진 DB(SQLCipher) settings 한 칸. connectedId는 지우지 못한 것만 잠깐 남는다 */
export function settingsCodefStore(db: Db): CodefLinkStore {
  return {
    get() {
      const v = db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(KEY) as string | undefined;
      if (v === undefined) return { link: null, orphans: [] };
      try {
        const j = JSON.parse(v) as Partial<CodefStoreValue>;
        const b = j.budget;
        const budget = b && typeof b.day === 'string' && Number.isSafeInteger(b.calls) && b.pwFails && typeof b.pwFails === 'object' ? b : undefined;
        return { link: j.link?.v === 1 ? j.link : null, orphans: Array.isArray(j.orphans) ? j.orphans.slice(0, 20) : [], ...(budget ? { budget } : {}) };
      } catch {
        return { link: null, orphans: [] };
      }
    },
    set(val) {
      db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(KEY, JSON.stringify(val));
    },
  };
}

export function memoryCodefStore(): CodefLinkStore {
  let v: CodefStoreValue = { link: null, orphans: [] };
  return { get: () => structuredClone(v), set: (x) => void (v = structuredClone(x)) };
}

/** 금고 engine 포트 codef.seal·cancel·forget. 프로필은 Phase 1 사업자 하나 */
export function vaultCodefSeal(vault: Pick<VaultClient, 'rpc'>, scope: 'business' | 'personal' = 'business'): CodefSealPort {
  return {
    seal: (p) => vault.rpc<SealResult>('codef.seal', { ...p, scope }),
    cancel: async () => void (await vault.rpc('codef.cancel', {})),
    forget: async (certId) => void (await vault.rpc('codef.forget', { certId, scope })),
  };
}

/**
 * 돈 맞추기 저장소(bank-mvp BankRepo) 어댑터. 저장소 타입을 직접 가져오지 않고 쓰는 메서드 모양만 받는다(bank-mvp가 합쳐지면 entry에서 한 줄로 붙인다).
 * 줄 열쇠는 codef 원천이 만든 것(codef:…)을 그대로 쓴다.
 */
export interface BankRepoLike {
  accountHmac(digits: string): string;
  accounts(profileId: string): Array<{ id: string }>;
  addAccount(input: { profileId: string; bank: unknown; number: unknown; alias?: unknown }, at: string): { id: string };
  revealAccount(id: string): string | null;
  importTxns(input: { profileId: string; accountId: string; source: 'api'; documentId: null; format: unknown; rows: Array<AutoTxnRow> }, at: string): { import: { rowCount: number; newCount: number } };
}

export function bankRepoSink(repo: BankRepoLike, profileId: () => string | null): BankTxnSink {
  const pid = () => {
    const p = profileId();
    if (!p) throw new Error('profile_missing');
    return p;
  };
  return {
    async ensureAccount(a) {
      const p = pid();
      const digits = a.number.replace(/\D/g, '');
      // 같은 번호의 내 계좌가 있으면 그것(파일로 먼저 넣었던 계좌). 저장소는 번호를 HMAC으로만 찾는다
      for (const acc of repo.accounts(p)) if (repo.revealAccount(acc.id)?.replace(/\D/g, '') === digits) return { accountId: acc.id };
      return { accountId: repo.addAccount({ profileId: p, bank: a.bank, number: digits, alias: a.alias }, new Date().toISOString()).id };
    },
    async accountNumber(id) {
      return repo.revealAccount(id);
    },
    async importRows(a) {
      const r = repo.importTxns({ profileId: pid(), accountId: a.accountId, source: 'api', documentId: null, format: { source: 'codef', from: a.range.from, to: a.range.to }, rows: a.rows }, new Date().toISOString());
      return { rowCount: r.import.rowCount, newCount: r.import.newCount };
    },
  };
}

/** 시험·개발: 메모리 원천 받기(줄 열쇠로 한 번만) */
export function memoryBankSink(): BankTxnSink & { rows: Map<string, AutoTxnRow[]>; numbers: Map<string, string> } {
  const rows = new Map<string, AutoTxnRow[]>();
  const numbers = new Map<string, string>();
  return {
    rows,
    numbers,
    async ensureAccount(a) {
      for (const [id, n] of numbers) if (n === a.number) return { accountId: id };
      const id = `acct-${numbers.size + 1}`;
      numbers.set(id, a.number);
      rows.set(id, []);
      return { accountId: id };
    },
    async accountNumber(id) {
      return numbers.get(id) ?? null;
    },
    async importRows(a) {
      const list = rows.get(a.accountId) ?? [];
      const have = new Set(list.map((r) => r.rowKey));
      let n = 0;
      for (const r of a.rows) {
        if (have.has(r.rowKey)) continue;
        list.push(r);
        have.add(r.rowKey);
        n++;
      }
      rows.set(a.accountId, list);
      return { rowCount: a.rows.length, newCount: n };
    },
  };
}
