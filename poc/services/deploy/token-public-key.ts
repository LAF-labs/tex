import { ed25519Private, ed25519RawPublic, key32 } from '../shared/src/index.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const seed = Buffer.concat(chunks).toString('utf8').trim();
const kid = process.env.TOKEN_KID ?? 'k1';
process.stdout.write(`${kid}:${ed25519RawPublic(ed25519Private(key32(seed, 'TOKEN_SIGNING_SEED'))).toString('base64')}\n`);
