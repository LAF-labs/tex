import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { acctClaimPublicKey, MockMailSender } from '../services/account/src/index.ts';
import { startAccount } from '../services/account/src/main.ts';
import { startRelay } from '../services/relay/src/main.ts';
import { ed25519Private, ed25519RawPublic } from '../services/shared/src/index.ts';

export interface CloudStack {
  host: string;
  mail: MockMailSender;
  claimPub: string;
  close(): Promise<void>;
}

const hex = () => randomBytes(32).toString('hex');
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

export async function startCloudStack(): Promise<CloudStack> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-cloud-stack-'));
  let acctPort = 0;
  let relayPort = 0;
  const isRelay = (p: string) => p.startsWith('/v1/mailboxes') || p.startsWith('/v1/rooms');
  const front: Server = createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (p.startsWith('/internal/') || p.startsWith('/dev/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"request.not_found"}');
    }
    const up = request({ host: '127.0.0.1', port: isRelay(p) ? relayPort : acctPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => (res.writeHead(502), res.end('{}')));
    req.pipe(up);
  });
  front.on('upgrade', (req: IncomingMessage, sock, head) => {
    const up = connect(relayPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const port = (front.address() as { port: number }).port;
  const host = `localhost:${port}`;
  const origin = `http://${host}`;
  [acctPort, relayPort] = await Promise.all([freePort(), freePort()]);
  const tokenSeed = hex();
  const internal = hex();
  const limitIdKey = hex();
  const claimSeed = hex();
  const mail = new MockMailSender();
  const account = await startAccount(
    {
      SAX_SQLITE_FILE: path.join(dir, 'account.db'), TOKEN_SIGNING_SEED: tokenSeed, CODE_MAC_KEY: hex(), ACCOUNT_PUBLIC_ORIGIN: origin, WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGINS: origin, BILLING_RETURN_URL: `${origin}/done`, PG_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', INTERNAL_CALL_KEY: internal,
      ACCT_CLAIM_SIGNING_KEY: claimSeed, KEY_ESCROW_KEY: hex(), LIMIT_ID_KEY: limitIdKey, PORT: String(acctPort), HOST: '127.0.0.1',
      RELAY_INTERNAL_URL: `http://127.0.0.1:${relayPort}`, STOP_HOOK_URLS: `http://127.0.0.1:${relayPort}`,
    },
    { mail },
  );
  const relay = await startRelay({
    SAX_SQLITE_FILE: path.join(dir, 'relay.db'), QUEUE_KEY: hex(), RELAY_PUBLIC_ORIGIN: origin,
    TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(tokenSeed, 'hex'))).toString('base64')}`,
    ACCOUNT_INTERNAL_URL: `http://127.0.0.1:${acctPort}`, INTERNAL_CALL_KEY: internal, LIMIT_ID_KEY: limitIdKey, PORT: String(relayPort), HOST: '127.0.0.1', RELAY_ROOMS: '1',
  });
  return {
    host,
    mail,
    claimPub: acctClaimPublicKey(claimSeed),
    close: async () => {
      front.closeAllConnections();
      front.close();
      await relay.close();
      await account.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}
