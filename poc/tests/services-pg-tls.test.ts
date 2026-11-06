// PostgreSQL TLS 고정 앵커(팀장 결정 2026-11-06, D09 §9.1): 앵커 없음이면 거절, 앵커 있음이면 연결. 검증을 끄는 설정은 없다.
// 가짜 PG 서버가 SSLRequest에 'S'로 답하고 TLS를 연다. 연결되면 시작 메시지에 ErrorResponse('tls-ok')로 끊는다(클라이언트는 그 메시지로 실패한다).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { SUPABASE_ROOT_2021_CA, pgConnectConfig } from '../services/shared/src/index.ts';

const FP = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

describe('고정 신뢰 앵커(Supabase Root 2021 CA)', () => {
  it('코드의 문자열과 저장소 공개 파일이 같고, 지문·만료·CA 표시가 맞다', () => {
    const file = fs.readFileSync(path.join(import.meta.dirname, '../services/deploy/supabase-root-2021.crt'), 'utf8');
    assert.equal(SUPABASE_ROOT_2021_CA, file);
    const c = new X509Certificate(SUPABASE_ROOT_2021_CA);
    assert.equal(c.fingerprint256, FP);
    assert.equal(c.ca, true);
    assert.match(c.subject, /CN=Supabase Root 2021 CA/);
    assert.equal(c.subject, c.issuer, '자체 서명 루트');
    assert.equal(new Date(c.validTo).toISOString().slice(0, 10), '2031-04-26');
  });
});

describe('DATABASE_URL → TLS 설정(문자열의 ssl 매개변수는 빼고 ssl을 직접 넘긴다)', () => {
  const remote = 'postgresql://sax_account.ref:pw-secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres';
  it('verify-full: 고정 앵커·rejectUnauthorized·servername, 문자열에 sslmode가 남지 않는다', () => {
    const c = pgConnectConfig(`${remote}?sslmode=verify-full`);
    assert.deepEqual(c.ssl, { ca: [SUPABASE_ROOT_2021_CA], rejectUnauthorized: true, servername: 'aws-0-ap-northeast-2.pooler.supabase.com' });
    assert.ok(!c.connectionString.includes('ssl'));
    assert.ok(c.connectionString.startsWith('postgresql://sax_account.ref:pw-secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres'));
  });
  it('require·verify-ca는 verify-full로 올린다(약해지지 않는다)', () => {
    for (const m of ['require', 'verify-ca']) assert.deepEqual(pgConnectConfig(`${remote}?sslmode=${m}`).ssl, pgConnectConfig(`${remote}?sslmode=verify-full`).ssl, m);
  });
  it('원격에서 sslmode 없음·disable·prefer·allow·no-verify, 파일·ssl 매개변수는 거부하고 오류에 URL·비밀번호가 없다', () => {
    for (const q of ['', '?sslmode=disable', '?sslmode=prefer', '?sslmode=allow', '?sslmode=no-verify', '?sslmode=verify-full&sslrootcert=/etc/x.pem', '?sslmode=verify-full&ssl=no-verify', '?sslmode=verify-full&sslcert=a', '?sslmode=verify-full&sslkey=a']) {
      assert.throws(
        () => pgConnectConfig(`${remote}${q}`),
        (e: Error) => /^config_DATABASE_URL/.test(e.message) && !e.message.includes('pw-secret') && !e.message.includes('supabase'),
        q,
      );
    }
    assert.throws(() => pgConnectConfig('mysql://x@y/z'), /config_DATABASE_URL/);
    assert.throws(() => pgConnectConfig('not a url'), /config_DATABASE_URL/);
    assert.throws(() => pgConnectConfig(`${remote}?sslmode=verify-full`, []), /config_DATABASE_CA/);
  });
  it('로컬 개발·시험 DB(localhost·127.0.0.1·::1)만 TLS 없이, IP 호스트는 SNI 없이', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]']) assert.equal(pgConnectConfig(`postgres://u@${h}:5432/db`).ssl, false, h);
    assert.equal(pgConnectConfig('postgres://u@localhost/db?sslmode=disable').ssl, false);
    assert.deepEqual(pgConnectConfig('postgres://u@10.0.0.5/db?sslmode=verify-full').ssl, { ca: [SUPABASE_ROOT_2021_CA], rejectUnauthorized: true });
  });
});

/**
 * 시험용 PKI(openssl CLI): 루트 둘(앵커·다른 루트), localhost용·다른 이름용 서버 인증서(체인 포함).
 * macOS 러너의 openssl은 LibreSSL이라 기본값이 다르다(EC 서명 SHA-1, 곡선 명시 매개변수, SKI·AKI 없음 → "CA signature digest algorithm too weak"·
 * "unable to verify the first certificate"). 다이제스트·키 식별자·keyUsage·일련번호를 모두 명시해 OpenSSL·LibreSSL에서 같은 체인을 만든다.
 */
function pki(dir: string) {
  const run = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  // 키는 Node가 만든다(이름 붙은 곡선 P-256). LibreSSL `-newkey ec`는 곡선을 명시 매개변수로 써 Node가 거부한다.
  const key = (name: string) => fs.writeFileSync(path.join(dir, `${name}.key`), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const root = (name: string) => {
    key(name);
    run('req', '-x509', '-sha256', '-new', '-key', `${name}.key`, '-nodes', '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-addext', 'subjectKeyIdentifier=hash');
  };
  const leaf = (name: string, dns: string) => {
    fs.writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${dns}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`);
    key(name);
    run('req', '-sha256', '-new', '-key', `${name}.key`, '-nodes', '-out', `${name}.csr`, '-subj', `/CN=${dns}`);
    run('x509', '-req', '-sha256', '-in', `${name}.csr`, '-CA', 'anchor.pem', '-CAkey', 'anchor.key', '-set_serial', `0x${randomBytes(8).toString('hex')}`, '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`);
  };
  root('anchor');
  root('other');
  leaf('srv', 'localhost');
  leaf('wrong', 'db.other.invalid');
  const r = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { anchor: r('anchor.pem'), other: r('other.pem'), srv: { key: r('srv.key'), cert: r('srv.pem') + r('anchor.pem') }, wrong: { key: r('wrong.key'), cert: r('wrong.pem') + r('anchor.pem') } };
}

/** 가짜 PG: SSLRequest → 'S' → TLS. 시작 메시지가 오면 ErrorResponse('tls-ok') */
async function fakePg(id: { key: string; cert: string }): Promise<{ port: number; secured: () => number; close: () => void }> {
  let secured = 0;
  const msg = (text: string) => {
    const body = Buffer.concat([Buffer.from('SFATAL\0C28000\0M', 'latin1'), Buffer.from(`${text}\0`, 'utf8'), Buffer.from([0])]);
    const head = Buffer.alloc(5);
    head.write('E', 0, 'latin1');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', (b) => {
      if (b.length < 8 || b.readInt32BE(4) !== 80877103) return void sock.destroy(); // TLS 없는 시작은 받지 않는다
      sock.write('S');
      const t = new tls.TLSSocket(sock, { isServer: true, key: id.key, cert: id.cert });
      t.on('error', () => {});
      t.on('secure', () => void secured++);
      t.once('data', () => void t.end(msg('tls-ok')));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: (server.address() as AddressInfo).port, secured: () => secured, close: () => void server.close() };
}

async function tryConnect(url: string, anchors?: readonly string[]): Promise<Error & { code?: string }> {
  const pool = new pg.Pool({ ...pgConnectConfig(url, anchors), max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => {});
  try {
    const c = await pool.connect();
    c.release();
    throw new Error('unexpected_connect');
  } catch (e) {
    return e as Error & { code?: string };
  } finally {
    await pool.end().catch(() => {});
  }
}

describe('TLS 연결: 앵커 없음이면 거절, 앵커 있음이면 연결', () => {
  let dir: string;
  let k: ReturnType<typeof pki>;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-pgtls-'));
    k = pki(dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('맞는 앵커: TLS 핸드셰이크를 마치고 서버 메시지까지 받는다(pg Pool, 문자열 sslmode=verify-full)', async () => {
    const s = await fakePg(k.srv);
    try {
      const e = await tryConnect(`postgresql://u:p@localhost:${s.port}/db?sslmode=verify-full`, [k.anchor]);
      assert.equal(e.message, 'tls-ok');
      assert.equal(s.secured(), 1);
    } finally {
      s.close();
    }
  });

  it('앵커 없음(다른 루트·운영 기본 앵커): 인증서 검증 실패로 거절한다', async () => {
    const s = await fakePg(k.srv);
    try {
      for (const anchors of [[k.other], undefined]) {
        const e = await tryConnect(`postgresql://u:p@localhost:${s.port}/db?sslmode=verify-full`, anchors);
        assert.match(String(e.code), /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/, e.message);
      }
    } finally {
      s.close();
    }
  });

  it('호스트 이름이 다른 인증서(같은 앵커)는 거절한다(verify-full)', async () => {
    const s = await fakePg(k.wrong);
    try {
      const e = await tryConnect(`postgresql://u:p@localhost:${s.port}/db?sslmode=require`, [k.anchor]);
      assert.equal(e.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    } finally {
      s.close();
    }
  });
});
