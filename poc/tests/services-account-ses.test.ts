// SES v2 메일 어댑터(ADR-015 어댑터 한 곳, D09 §1·§3): SigV4 서명·본문·오류 분류·재시도 여부·송신 허용 목록·본문 PII.
// 실제 AWS에는 붙지 않는다. 가짜 SES(127.0.0.1 HTTP 서버)가 받은 요청을 실제 SES처럼 서명 검증한다. 자격 증명은 시험용 가짜 값이다.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Logger, looksSensitive } from '../services/shared/src/index.ts';
import { MailError, SES_PATH, SesMailSender, amzDate, buildAccount, mailContent, sesEndpointAllowed, sigv4, type MailKind, type NoticeKind } from '../services/account/src/index.ts';

const SES_HOST = 'email.ap-northeast-2.amazonaws.com';
const SES_URL = `https://${SES_HOST}${SES_PATH}`;
// 시험용 가짜 자격 증명(형식만 맞다)
const AKID = 'AKIATESTTESTTEST0000';
const SECRET = 'testSecretKeyForSigV4OnlyNotReal0000AAAA';
const FROM = 'no-reply@mail.test.invalid';
const TO = 'someone@example.com';
const T0 = Date.UTC(2026, 10, 7, 3, 4, 5);

const realFetch = globalThis.fetch;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/** 가짜 SES의 서명 검증(어댑터 코드를 쓰지 않고 다시 계산한다). host는 실제 SES가 볼 값으로 둔다(시험은 127.0.0.1로 돌려 보낸다) */
function verifySig(method: string, p: string, h: http.IncomingHttpHeaders, body: string): { ok: boolean; why?: string } {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(String(h.authorization ?? ''));
  if (!m) return { ok: false, why: 'authorization 모양' };
  const [, akid, day, region, service, signed, sig] = m;
  if (akid !== AKID || region !== 'ap-northeast-2' || service !== 'ses') return { ok: false, why: 'scope' };
  const date = String(h['x-amz-date'] ?? '');
  if (date.slice(0, 8) !== day) return { ok: false, why: 'date' };
  if (h['x-amz-content-sha256'] !== sha256(body)) return { ok: false, why: 'payload hash' };
  const view: Record<string, string> = { ...(h as Record<string, string>), host: SES_HOST };
  const names = signed!.split(';');
  const canon = [method, p, '', names.map((n) => `${n}:${String(view[n] ?? '').trim()}\n`).join(''), signed, sha256(body)].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, `${day}/${region}/${service}/aws4_request`, sha256(canon)].join('\n');
  const k = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, day!), region!), service!), 'aws4_request');
  return createHmac('sha256', k).update(toSign).digest('hex') === sig ? { ok: true } : { ok: false, why: 'signature' };
}

interface Got {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
type Reply = { status: number; headers?: Record<string, string>; body?: string } | 'hang';

describe('SES v2 메일 어댑터', () => {
  let server: http.Server;
  let base: string;
  const got: Got[] = [];
  const urls: string[] = [];
  let reply: Reply = { status: 200, body: '{"MessageId":"m-1"}' };
  const events: string[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        got.push({ method: req.method!, path: req.url!, headers: req.headers, body });
        if (reply === 'hang') return;
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(reply.body ?? '');
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    got.length = 0;
    urls.length = 0;
    events.length = 0;
    reply = { status: 200, body: '{"MessageId":"m-1"}' };
  });

  /** SES 원점을 가짜 서버로 돌린다. 어댑터가 부른 URL은 그대로 기록한다 */
  const fetchFn: typeof fetch = (input, init) => {
    const u = String(input);
    urls.push(u);
    return realFetch(u.replace(`https://${SES_HOST}`, base), init);
  };
  const sender = (o: { timeoutMs?: number; fetch?: typeof fetch } = {}) =>
    new SesMailSender({ region: 'ap-northeast-2', from: FROM, accessKeyId: AKID, secretAccessKey: SECRET, fetchFn: o.fetch ?? fetchFn, now: () => T0, timeoutMs: o.timeoutMs, onEvent: (n) => void events.push(n) });

  it('SigV4: AWS 공개 시험 벡터(get-vanilla)와 같은 서명', () => {
    const a = sigv4({
      method: 'GET',
      path: '/',
      headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
      payloadSha256: sha256(''),
      amzDate: '20150830T123600Z',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
    assert.equal(a, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    assert.equal(amzDate(Date.UTC(2015, 7, 30, 12, 36, 0)), '20150830T123600Z');
  });

  it('보내기: POST 허용 경로 하나, 서명 검증 통과(scope·날짜·본문 해시), 본문 모양, 수신 주소는 Destination에만', async () => {
    await sender().sendLoginCode(TO, '123456');
    assert.deepEqual(urls, [SES_URL]);
    assert.equal(got.length, 1);
    const g = got[0]!;
    assert.equal(g.method, 'POST');
    assert.equal(g.path, SES_PATH);
    assert.equal(g.headers['content-type'], 'application/json');
    assert.equal(g.headers['x-amz-date'], amzDate(T0));
    assert.deepEqual(verifySig(g.method, g.path, g.headers, g.body), { ok: true });
    assert.match(String(g.headers.authorization), new RegExp(`Credential=${AKID}/20261107/ap-northeast-2/ses/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, `));
    // 비밀 키는 어떤 헤더·본문에도 없다
    assert.ok(!JSON.stringify(g.headers).includes(SECRET) && !g.body.includes(SECRET));
    const b = JSON.parse(g.body) as { FromEmailAddress: string; Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string; Charset: string }; Body: { Text: { Data: string; Charset: string } } } } };
    assert.deepEqual(Object.keys(b).sort(), ['Content', 'Destination', 'FromEmailAddress']);
    assert.equal(b.FromEmailAddress, FROM);
    assert.deepEqual(b.Destination, { ToAddresses: [TO] });
    assert.equal(b.Content.Simple.Subject.Charset, 'UTF-8');
    assert.equal(b.Content.Simple.Body.Text.Charset, 'UTF-8');
    assert.ok(b.Content.Simple.Body.Text.Data.includes('123456'));
    assert.ok(!JSON.stringify(b.Content).includes(TO), '수신 주소는 내용에 없다');
    assert.deepEqual(events, ['account.mail_ses.sent']);
    // 가짜 SES 검증기 자체 확인: 본문이나 서명 헤더를 바꾸면 통과하지 않는다
    assert.equal(verifySig(g.method, g.path, g.headers, g.body + ' ').ok, false);
    assert.equal(verifySig(g.method, g.path, { ...g.headers, 'x-amz-date': '20261107T030406Z' }, g.body).ok, false);
    assert.equal(verifySig('PUT', g.path, g.headers, g.body).ok, false);
  });

  it('오류 분류: 429·한도는 throttled, 5xx는 unavailable(둘 다 재시도), 401·403은 auth_failed, 계정 정지·발송 중지·도메인 미인증은 config, 그 밖 400은 rejected(재시도 안 함)', async () => {
    const cases: Array<[number, string, MailError['code'], boolean]> = [
      [429, '', 'mail.throttled', true],
      [400, 'TooManyRequestsException', 'mail.throttled', true],
      [400, 'LimitExceededException:http://internal.amazon.com/coral/com.amazon.ses/', 'mail.throttled', true],
      [500, 'InternalFailure', 'mail.unavailable', true],
      [503, '', 'mail.unavailable', true],
      [403, 'SignatureDoesNotMatch', 'mail.auth_failed', false],
      [401, '', 'mail.auth_failed', false],
      [400, 'AccountSuspendedException', 'mail.config', false],
      [400, 'SendingPausedException', 'mail.config', false],
      [400, 'MailFromDomainNotVerifiedException', 'mail.config', false],
      [404, 'NotFoundException', 'mail.config', false],
      [400, 'MessageRejected', 'mail.rejected', false],
      [400, 'BadRequestException', 'mail.rejected', false],
      [400, '', 'mail.rejected', false],
    ];
    for (const [status, type, code, retryable] of cases) {
      events.length = 0;
      // 실제 SES 오류 본문은 주소를 되풀이할 수 있다. 오류·이벤트로 새지 않아야 한다
      reply = { status, headers: type ? { 'x-amzn-errortype': type } : {}, body: JSON.stringify({ message: `Email address is not verified: ${TO}` }) };
      const e = await sender().sendNotice(TO, 'device_enrolled').then(
        () => assert.fail(`${status} ${type}: 성공하면 안 된다`),
        (x: unknown) => x,
      );
      assert.ok(e instanceof MailError, `${status} ${type}`);
      assert.equal(e.code, code, `${status} ${type}`);
      assert.equal(e.retryable, retryable, `${status} ${type}`);
      assert.ok(!inspect(e).includes(TO) && !JSON.stringify(e).includes(TO));
      assert.deepEqual(events, [`account.mail_ses.${code.slice(5)}`]);
    }
  });

  it('네트워크 오류·시간 초과는 재시도 가능한 unavailable, 리디렉션은 따르지 않는다', async () => {
    const down = sender({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await assert.rejects(down.sendLoginCode(TO, '123456'), (e: MailError) => e.code === 'mail.unavailable' && e.retryable);
    reply = 'hang';
    await assert.rejects(sender({ timeoutMs: 100 }).sendLoginCode(TO, '123456'), (e: MailError) => e.code === 'mail.unavailable' && e.retryable);
    // 리디렉션: 다른 곳으로 가지 않는다(가짜 서버에 한 번만 닿는다)
    got.length = 0;
    reply = { status: 307, headers: { location: `${base}/elsewhere` } };
    await assert.rejects(sender().sendLoginCode(TO, '123456'), (e: MailError) => e.code === 'mail.unavailable');
    assert.deepEqual(got.map((g) => g.path), [SES_PATH]);
  });

  it('2xx면 MessageId가 없어도 다시 보내지 않는다(중복 발송 방지), 이벤트로만 남긴다', async () => {
    reply = { status: 200, body: '{}' };
    await sender().sendNotice(TO, 'password_set');
    reply = { status: 200, body: 'not json' };
    await sender().sendNotice(TO, 'password_set');
    assert.deepEqual(events, ['account.mail_ses.sent_no_id', 'account.mail_ses.sent_no_id']);
    assert.equal(got.length, 2);
  });

  it('송신 허용 목록: 서울 리전의 SendEmail 경로 하나. 다른 리전·호스트·경로·쿼리·조각·http·사용자 정보는 거부', () => {
    assert.equal(sesEndpointAllowed(SES_URL), true);
    for (const u of [
      'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
      'https://email.ap-northeast-2.amazonaws.com.evil.test/v2/email/outbound-emails',
      'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails/',
      'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails?x=1',
      'https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails#x',
      'https://email.ap-northeast-2.amazonaws.com/v2/email/identities',
      'http://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails',
      'https://u:p@email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails',
      'https://email.ap-northeast-2.amazonaws.com:8443/v2/email/outbound-emails',
      'not a url',
    ])
      assert.equal(sesEndpointAllowed(u), false, u);
    assert.throws(() => new SesMailSender({ region: 'us-east-1' as 'ap-northeast-2', from: FROM, accessKeyId: AKID, secretAccessKey: SECRET }), /config_SES_REGION/);
  });

  it('입력 거부: 주소 형식(헤더 주입 포함)·6자리가 아닌 코드는 보내지 않는다', async () => {
    for (const to of ['a@b.com\r\nBcc: x@y.com', 'no-at', 'a@b', `${'x'.repeat(65)}@example.com`])
      await assert.rejects(sender().sendNotice(to, 'device_enrolled'), (e: MailError) => e.code === 'mail.rejected' && !e.retryable);
    for (const code of ['12345', '1234567', 'abcdef', '12345\n'])
      await assert.rejects(sender().sendLoginCode(TO, code), (e: MailError) => e.code === 'mail.rejected');
    assert.equal(got.length, 0);
  });

  it('본문 PII: 모든 종류의 제목·본문에 이메일 주소·식별자 모양이 없고, 값은 코드 6자리뿐(제목에는 코드도 없음)', async () => {
    // Record로 두어 NoticeKind가 늘면 컴파일이 깨진다(이 시험이 새 종류를 빠뜨리지 않게)
    const NOTICES: Record<NoticeKind, true> = {
      device_enrolled: true,
      device_suspended: true,
      device_auto_suspended: true,
      device_delete_pending: true,
      device_revoked: true,
      aik_pinned: true,
      passkey_added: true,
      password_set: true,
      password_reset: true,
      password_locked: true,
      sessions_revoked: true,
    };
    const kinds: MailKind[] = ['code', 'reset_code', 'reauth_code', ...(Object.keys(NOTICES) as NoticeKind[])];
    const CODE = '482913';
    for (const k of kinds) {
      const c = mailContent(k, CODE);
      const all = `${c.subject}\n${c.text}`;
      assert.ok(!all.includes('@'), `${k}: @`);
      assert.ok(!/https?:|www\./i.test(all), `${k}: 링크`);
      for (const line of all.split('\n')) assert.ok(!looksSensitive(line), `${k}: ${line}`);
      assert.ok(!/\d/.test(c.subject), `${k}: 제목에 숫자`);
      const digits = all.match(/\d+/g) ?? [];
      if (k === 'code' || k === 'reset_code' || k === 'reauth_code') assert.deepEqual(digits.filter((d) => d.length > 2), [CODE], k);
      else assert.ok(!all.includes(CODE) && digits.every((d) => d.length <= 2), `${k}: 알림에 코드·숫자 값`);
    }
    // 실제로 보낸 요청: 주소는 FromEmailAddress·Destination에만, 내용에는 주소·계정 값이 없다
    const s = sender();
    for (const k of kinds) {
      got.length = 0;
      if (k === 'code') await s.sendLoginCode(TO, CODE);
      else if (k === 'reset_code') await s.sendResetCode(TO, CODE);
      else if (k === 'reauth_code') await s.sendReauthCode(TO, CODE);
      else await s.sendNotice(TO, k);
      const b = JSON.parse(got[0]!.body) as { Content: unknown };
      const content = JSON.stringify(b.Content);
      assert.ok(!content.includes('@') && !content.includes('example.com'), k);
    }
    // 이벤트에는 이름만(주소·코드 없음)
    assert.ok(events.every((e) => /^account\.mail_ses\.[a-z_]+$/.test(e)));
  });

  it('비밀이 직렬화·inspect·오류로 새지 않는다', async () => {
    const s = sender();
    assert.equal(JSON.stringify(s), '{"provider":"ses","region":"ap-northeast-2"}');
    assert.ok(!inspect(s, { depth: 5, showHidden: true }).includes(SECRET));
    reply = { status: 403, headers: { 'x-amzn-errortype': 'InvalidSignatureException' }, body: `{"message":"key ${AKID}"}` };
    const e = await s.sendLoginCode(TO, '123456').catch((x: unknown) => x);
    assert.ok(!inspect(e).includes(SECRET) && !inspect(e).includes(AKID));
  });

  it('fromEnv: SES env 3개가 다 있어야 하고 형식이 틀리면 기동 거부(값은 오류에 없음)', () => {
    const env = { SES_FROM_ADDRESS: FROM, SES_ACCESS_KEY_ID: AKID, SES_SECRET_ACCESS_KEY: SECRET };
    assert.ok(SesMailSender.fromEnv(env) instanceof SesMailSender);
    for (const n of Object.keys(env)) assert.throws(() => SesMailSender.fromEnv({ ...env, [n]: '' }), new RegExp(`^Error: config_${n}$`));
    assert.throws(() => SesMailSender.fromEnv({ ...env, SES_ACCESS_KEY_ID: 'lower-case-key-id' }), (e: Error) => e.message === 'config_SES_ACCESS_KEY_ID');
    assert.throws(() => SesMailSender.fromEnv({ ...env, SES_FROM_ADDRESS: 'no-at' }), (e: Error) => e.message === 'config_SES_FROM_ADDRESS');
    assert.throws(() => SesMailSender.fromEnv({ ...env, SES_SECRET_ACCESS_KEY: 'short' }), (e: Error) => !e.message.includes('short'));
  });

  it('buildAccount: MAIL_PROVIDER는 mock 또는 ses만, ses는 SES env 3개 필요. ses면 로그인 코드가 SES로 간다', async () => {
    const hex32 = () => createHash('sha256').update(Math.random().toString()).digest('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-acct-ses-'));
    const env = {
      SAX_SQLITE_FILE: path.join(dir, 'a.db'),
      TOKEN_SIGNING_SEED: hex32(),
      INTERNAL_CALL_KEY: hex32(),
      CODE_MAC_KEY: hex32(),
      LIMIT_ID_KEY: hex32(),
      ACCOUNT_PUBLIC_ORIGIN: 'https://account.test.invalid',
      WEBAUTHN_RP_ID: 'account.test.invalid',
      WEBAUTHN_ORIGINS: 'https://account.test.invalid',
      BILLING_RETURN_URL: 'https://app.test.invalid/b',
      PG_PROVIDER: 'mock',
    };
    try {
      await assert.rejects(buildAccount(env), /config_provider/);
      await assert.rejects(buildAccount({ ...env, MAIL_PROVIDER: 'smtp' }), /config_provider/);
      await assert.rejects(buildAccount({ ...env, MAIL_PROVIDER: 'ses' }), /config_SES_FROM_ADDRESS/);
      const m = await buildAccount({ ...env, MAIL_PROVIDER: 'mock' });
      await m.db.close();
      // ses: 어댑터가 만들어질 때의 fetch를 쓴다. 시험 동안만 가짜 SES로 돌린다(실제 AWS에 닿지 않게)
      globalThis.fetch = fetchFn;
      const sink: string[] = [];
      const s = await buildAccount({ ...env, MAIL_PROVIDER: 'ses', SES_FROM_ADDRESS: FROM, SES_ACCESS_KEY_ID: AKID, SES_SECRET_ACCESS_KEY: SECRET }, { logger: new Logger('account', (l) => void sink.push(l)) });
      try {
        await s.svc.startEmailCode(TO);
        assert.deepEqual(urls, [SES_URL]);
        assert.deepEqual(verifySig(got[0]!.method, got[0]!.path, got[0]!.headers, got[0]!.body), { ok: true });
        assert.ok(!got[0]!.body.includes(SECRET));
      } finally {
        await s.db.close();
      }
      assert.ok(sink.some((l) => l.includes('"event":"account.mail_ses.sent"')));
      assert.ok(sink.every((l) => !l.includes(TO) && !looksSensitive(l)));
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
