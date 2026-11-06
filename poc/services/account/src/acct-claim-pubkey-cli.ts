// 고정용 acct_claim 공개키 출력: ACCT_CLAIM_SIGNING_KEY(hex 64자)를 표준 입력으로 받아 표준 base64 공개키를 출력한다(공개 값).
// 시드는 인자로 넘기지 않는다(셸 기록에 남지 않게): cd poc && node --conditions=development services/account/src/acct-claim-pubkey-cli.ts < 시드_파일
import { acctClaimPublicKey } from './acct-claim.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
process.stdout.write(`${acctClaimPublicKey(Buffer.concat(chunks).toString('utf8').trim())}\n`);
