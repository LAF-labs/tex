import { acctClaimPublicKey } from './acct-claim.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
process.stdout.write(`${acctClaimPublicKey(Buffer.concat(chunks).toString('utf8').trim())}\n`);
