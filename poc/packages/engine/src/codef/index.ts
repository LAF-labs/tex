// 계좌 자동조회(CODEF) 엔진 모듈: 클라이언트·연결 서비스·원천 어댑터와 엔진 안 연결부(설정 저장·금고 봉인·돈 맞추기).
import { ProfileRepo, type Db } from '@sax/db';
import { CodefError } from './codes.ts';
import type { VaultClient } from '../vault-client.ts';
import type { BankService } from '../bank/service.ts';
import type { CodefBankPort, CodefLinkStore, CodefSealPort, CodefStoreValue, SealResult } from './link.ts';

export * from './client.ts';
export * from './codes.ts';
export * from './link.ts';
export * from './source.ts';

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
 * 돈 맞추기(BankService, 같은 엔진 프로세스) 쪽 연결부. 사업장은 Phase 1 사업자 프로필 하나다.
 * 계좌는 같은 번호가 있으면 그것을 쓴다(파일로 먼저 넣은 계좌). 거래 넣기·맞추기는 bank.refresh가 원천(codefTxnSource)으로 한다.
 */
export function bankServicePort(bank: BankService, db: Db): CodefBankPort {
  const pid = () => new ProfileRepo(db).list().find((p) => p.kind === 'business')?.id ?? null;
  return {
    ready() {
      const p = pid();
      if (!p) return 'bank_not_ready';
      return bank.consentOf(p) ? null : 'bank_consent_required';
    },
    async link(a) {
      const profileId = pid();
      if (!profileId) throw new CodefError('bank_not_ready');
      const digits = a.number.replace(/\D/g, '');
      const found = bank.repo.accounts(profileId).find((x) => bank.repo.revealAccount(x.id) === digits);
      const accountId = found ? found.id : ((await bank.handle('bank.addAccount', { profileId, bank: a.bank, number: digits, alias: a.alias })) as { id: string }).id;
      await bank.handle('bank.setLink', { profileId, accountId, state: 'auto_connected', provider: 'codef' });
      return { accountId, profileId };
    },
    async refresh(a) {
      await bank.handle('bank.refresh', { profileId: a.profileId, accountId: a.accountId });
    },
    async unlink(a) {
      await bank.handle('bank.setLink', { profileId: a.profileId, accountId: a.accountId, state: 'file_only' });
    },
  };
}
