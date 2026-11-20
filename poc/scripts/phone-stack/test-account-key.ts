import { b64, signAcctClaim } from '../../packages/remote/src/index.ts';

export const TEST_ONLY_SEED_HEX = '372cad9361b4e90ef21b02dd9191bc93b1149bc015d73f783203f8a4806fa1ee';
const TEST_ONLY_SEED = Buffer.from(TEST_ONLY_SEED_HEX, 'hex');

export function devAcctClaim(aikPub: Uint8Array, email: string, accountId = 'acc_dev'): string {
  const now = Date.now();
  return signAcctClaim(new Uint8Array(TEST_ONLY_SEED), { account_id: accountId, email, aik_pub: b64(aikPub), iat: now, exp: now + 600_000 });
}
