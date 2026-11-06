// TOKEN_PUBLIC_KEYS 값 만들기(공개 값): 계정 TOKEN_SIGNING_SEED(hex 64자)를 표준 입력으로 받아 `k1:<base64 공개키>`를 출력한다.
// 시드는 인자로 넘기지 않는다(셸 기록에 남지 않게): cd poc && node --conditions=development services/deploy/token-public-key.ts < 시드_파일
// 또는 실행 뒤 붙여 넣고 Ctrl-D. 출력(공개키)만 env 화면에 넣는다.
import { ed25519Private, ed25519RawPublic, key32 } from '../shared/src/index.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const seed = Buffer.concat(chunks).toString('utf8').trim();
const kid = process.env.TOKEN_KID ?? 'k1';
process.stdout.write(`${kid}:${ed25519RawPublic(ed25519Private(key32(seed, 'TOKEN_SIGNING_SEED'))).toString('base64')}\n`);
