// 개발·시험 전용 계정 서비스 키(acct_claim 서명 대역, 설계 #120). 실제 계정 서비스 키가 아니다. 공개해도 되는 시험 키다.
// 공개키는 src/config.ts DEV_ACCOUNT_KEY에 있다. 개발 스택(dev/stack.ts·dummy-pc.ts)만 이 비밀키로 서명한다.
// 실제 키는 클라우드 세션이 계정 서비스에 만들고, 릴리스 빌드의 ACCOUNT_KEYS에 그 공개키를 넣는다.
import { b64, signAcctClaim } from '../../../packages/remote/src/index.ts';

/** 개발 스택의 계정 서비스 ACCT_CLAIM_SIGNING_KEY(hex 64). 공개된 시험 시드다. */
export const TEST_ONLY_SEED_HEX = '372cad9361b4e90ef21b02dd9191bc93b1149bc015d73f783203f8a4806fa1ee';
const TEST_ONLY_SEED = Buffer.from(TEST_ONLY_SEED_HEX, 'hex');

export function devAcctClaim(aikPub: Uint8Array, email: string, accountId = 'acc_dev'): string {
  const now = Date.now(); // UTC 밀리초, exp = iat + 600000(SIGNING.md §8)
  return signAcctClaim(new Uint8Array(TEST_ONLY_SEED), { account_id: accountId, email, aik_pub: b64(aikPub), iat: now, exp: now + 600_000 });
}
