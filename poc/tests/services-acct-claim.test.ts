// acct_claim(서버 서명 계정 클레임, D08 §4.2 7단계, 팀장 결정 2026-11-06): 서명 검증, 만료, 다른 계정·폰·세션 토큰 거부, 전용 키 분리.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { signCtx, ed25519Private } from '../services/shared/src/index.ts';
import { ACCT_CLAIM_TTL_MS, AcctClaimSigner, DEVICE, acctClaimPublicKey, startAccount, verifyAcctClaim, type SignedAcctClaim } from '../services/account/src/index.ts';
import { ACCOUNT_ORIGIN, accountStack, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';
import { client } from './services-kit.ts';

const PATH = '/v1/acct-claim';

describe('acct_claim 발급(GET /v1/acct-claim, 데스크톱 기기 토큰)', () => {
  let s: Stack;
  let pc: Signed;
  beforeEach(async () => {
    s = await accountStack();
    pc = await signedDesktop(s, 'Owner@Example.com'.toLowerCase());
  });
  afterEach(() => s.close());

  const get = async (who: Pick<Signed, 'token' | 'headers'>, token?: string) => {
    const t = token ?? (await who.token());
    return s.req('GET', PATH, { headers: who.headers('GET', ACCOUNT_ORIGIN, PATH, t) });
  };

  it('서명 입력 utf8("SAX-acct-claim-v1")‖JCS({account_id, email, aik_pub, iat, exp})를 고정 공개키로 검증한다. 필드를 바꾸면 실패', async () => {
    const r = await get(pc);
    assert.equal(r.status, 200, r.text);
    const body = r.json as unknown as SignedAcctClaim;
    const now = s.clock.now();
    assert.deepEqual(body.claim, { account_id: pc.accountId, email: 'owner@example.com', aik_pub: pc.aik.b64, iat: now, exp: now + 10 * 60_000 });
    assert.deepEqual(Object.keys(body).sort(), ['claim', 'sig']);
    assert.ok(verifyAcctClaim(s.acctClaimPub!, body, now, pc.aik.b64));
    // 필드 변조·추가, 다른 AIK 기대, 다른 공개키(기기 토큰 키 등)는 모두 실패
    for (const claim of [{ ...body.claim, email: 'attacker@example.com' }, { ...body.claim, account_id: 'x' }, { ...body.claim, exp: body.claim.exp + 1 }, { ...body.claim, extra: 1 }]) {
      assert.equal(verifyAcctClaim(s.acctClaimPub!, { ...body, claim }, now), false, JSON.stringify(claim));
    }
    assert.equal(verifyAcctClaim(s.acctClaimPub!, body, now, pc.aik.b64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))), false);
    assert.equal(verifyAcctClaim(new AcctClaimSigner(ed25519Private(randomBytes(32))).publicKey, body, now), false);
    assert.equal(verifyAcctClaim(s.acctClaimPub!, { claim: body.claim, sig: 'AAAA' }, now), false);
    // 맥락 분리: 같은 키로 다른 맥락(SAX-token-v1)에 서명한 값은 acct_claim이 아니다
    const seed = randomBytes(32);
    const signer = new AcctClaimSigner(ed25519Private(seed));
    const other = signCtx('SAX-token-v1', body.claim, ed25519Private(seed)).toString('base64');
    assert.equal(verifyAcctClaim(signer.publicKey, { claim: body.claim, sig: other }, now), false);
    assert.ok(verifyAcctClaim(signer.publicKey, signer.sign(body.claim, now), now));
  });

  it('수명은 10분이다: 만료 시각이 되면 검증에 실패하고, 다시 받으면 새 iat로 통과한다. 수명이 10분보다 긴 클레임도 거부', async () => {
    const r = await get(pc);
    const body = r.json as unknown as SignedAcctClaim;
    s.clock.advance(ACCT_CLAIM_TTL_MS - 1);
    assert.ok(verifyAcctClaim(s.acctClaimPub!, body, s.clock.now()));
    s.clock.advance(1);
    assert.equal(verifyAcctClaim(s.acctClaimPub!, body, s.clock.now()), false);
    const again = (await get(pc)).json as unknown as SignedAcctClaim;
    assert.equal(again.claim.iat, s.clock.now());
    assert.ok(verifyAcctClaim(s.acctClaimPub!, again, s.clock.now(), pc.aik.b64));
    // 서명은 맞아도 수명이 10분을 넘거나 iat가 미래(60초 넘게)면 거부
    const seed = randomBytes(32);
    const signer = new AcctClaimSigner(ed25519Private(seed));
    const now = s.clock.now();
    const longClaim = { ...signer.sign(again.claim, now).claim, exp: now + ACCT_CLAIM_TTL_MS + 1 };
    const long = { claim: longClaim, sig: signCtx('SAX-acct-claim-v1', longClaim, ed25519Private(seed)).toString('base64') };
    assert.equal(verifyAcctClaim(signer.publicKey, long, now), false);
    assert.equal(verifyAcctClaim(signer.publicKey, signer.sign(again.claim, now + 61_000), now), false);
    assert.ok(verifyAcctClaim(signer.publicKey, signer.sign(again.claim, now + 59_000), now));
  });

  it('클레임은 언제나 토큰 계정의 것이다: 다른 계정 PC는 자기 계정 클레임만 받고, 그것은 이 계정 AIK 기대로 검증되지 않는다', async () => {
    const other = await signedDesktop(s, 'attacker@example.com');
    const r = await get(other);
    assert.equal(r.status, 200, r.text);
    const body = r.json as unknown as SignedAcctClaim;
    assert.equal(body.claim.account_id, other.accountId);
    assert.equal(body.claim.email, 'attacker@example.com');
    assert.equal(body.claim.aik_pub, other.aik.b64);
    assert.equal(verifyAcctClaim(s.acctClaimPub!, body, s.clock.now(), pc.aik.b64), false);
    // 쿼리로 다른 계정을 지정해도 토큰 계정의 클레임만 나온다
    const t = await other.token();
    const q = await s.req('GET', `${PATH}?account_id=${pc.accountId}`, { headers: other.headers('GET', ACCOUNT_ORIGIN, `${PATH}?account_id=${pc.accountId}`, t) });
    if (q.status === 200) assert.equal((q.json as unknown as SignedAcctClaim).claim.account_id, other.accountId);
  });

  it('다른 계정의 기기 토큰·다른 기기 키의 DPoP·폰 토큰·계정 세션·토큰 없음은 거부한다', async () => {
    const other = await signedDesktop(s, 'attacker@example.com');
    // 다른 계정 PC의 토큰을 이 PC 키로 증명(토큰 탈취): DPoP cnf 불일치 401
    const stolen = await other.token();
    assert.equal((await get(pc, stolen)).status, 401);
    // 폰 기기 토큰은 403
    const phone = await signedPhone(s, pc);
    const rp = await get(phone);
    assert.equal(rp.status, 403, rp.text);
    assert.equal(rp.json.error, 'account.scope_denied');
    // 계정 세션·인증 없음은 401
    assert.equal((await s.req('GET', PATH, { headers: { authorization: `Bearer ${pc.session}` } })).status, 401);
    assert.equal((await s.req('GET', PATH)).status, 401);
  });

  it('정지된 PC는 받을 수 없고, 기기당 시간 한도를 넘으면 429', async () => {
    const t = await pc.token();
    for (let i = 0; i < DEVICE.acctClaimsPerHour; i++) assert.equal((await get(pc, t)).status, 200, String(i));
    assert.equal((await get(pc, t)).json.error, 'policy.rate_limited');
    await s.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1", [pc.d.id]);
    // 정지는 한도보다 먼저 본다(같은 토큰이라도 정지 뒤에는 403)
    assert.equal((await get(pc, t)).json.error, 'account.device_suspended');
  });
});

describe('acct_claim 서명 키 구성(ACCT_CLAIM_SIGNING_KEY)', () => {
  it('키가 없으면 경로가 닫힌다(인증된 PC도 404)', async () => {
    const s = await accountStack(undefined, { acctClaims: false });
    try {
      const pc = await signedDesktop(s, 'nokey@example.com');
      const t = await pc.token();
      const r = await s.req('GET', PATH, { headers: pc.headers('GET', ACCOUNT_ORIGIN, PATH, t) });
      assert.equal(r.status, 404);
      assert.equal(r.json.error, 'request.not_found');
    } finally {
      s.close();
    }
  });

  const env = (extra: Record<string, string>) => ({
    SAX_SQLITE_FILE: ':memory:',
    TOKEN_SIGNING_SEED: '11'.repeat(32),
    CODE_MAC_KEY: '22'.repeat(32),
    LIMIT_ID_KEY: '33'.repeat(32),
    ACCOUNT_PUBLIC_ORIGIN: 'https://account.test.invalid',
    WEBAUTHN_RP_ID: 'account.test.invalid',
    WEBAUTHN_ORIGINS: 'https://account.test.invalid',
    BILLING_RETURN_URL: 'https://app.test.invalid/done',
    INTERNAL_TOKEN: 'internal-test',
    PG_PROVIDER: 'mock',
    MAIL_PROVIDER: 'mock',
    HOST: '127.0.0.1',
    PORT: '0',
    ...extra,
  });

  it('기기 토큰 키와 같은 값이거나 형식이 틀리면 기동하지 않는다. 다른 값이면 기동한다', async () => {
    await assert.rejects(startAccount(env({ ACCT_CLAIM_SIGNING_KEY: '11'.repeat(32) })), /config_ACCT_CLAIM_SIGNING_KEY/);
    await assert.rejects(startAccount(env({ ACCT_CLAIM_SIGNING_KEY: 'not-hex' })), /config_ACCT_CLAIM_SIGNING_KEY/);
    const ok = await startAccount(env({ ACCT_CLAIM_SIGNING_KEY: '44'.repeat(32) }));
    try {
      assert.equal((await client(ok.url)('GET', PATH)).status, 401);
    } finally {
      await ok.close();
    }
  });

  it('고정용 공개키 출력 도구는 표준 입력의 시드로 서명기와 같은 공개키를 낸다', () => {
    const seed = randomBytes(32).toString('hex');
    const cli = fileURLToPath(new URL('../services/account/src/acct-claim-pubkey-cli.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--conditions=development', cli], { input: `${seed}\n`, encoding: 'utf8' }).trim();
    assert.equal(out, acctClaimPublicKey(seed));
    assert.equal(out, AcctClaimSigner.fromSeedHex(seed).publicKey);
    assert.equal(Buffer.from(out, 'base64').length, 32);
  });
});
