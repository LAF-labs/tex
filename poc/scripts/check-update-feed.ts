// 운영 업데이트 피드 점검(B6). 설치된 앱과 같은 코드로 본다: egress로 latest.json 바이트 → 서명·기간·채널·버전(decideUpdate)
// → 투명성 로그 포함 증명(checkReleaseLogged) → zip이 같은 주소에서 같은 크기(--download면 sha512까지)로 내려오는지.
// 읽기만 한다(GET). 실행(poc/에서): node --conditions=development scripts/check-update-feed.ts [--channel beta] [--installed 0.1.10] [--download] [--expect 0.1.12]
// 로컬 피드 점검: --feed http://127.0.0.1:<포트> --trust <trust.json>(시험 키). 운영 점검은 둘 다 빼고 앱 핀 키·운영 origin을 쓴다.
// 끝 코드: 0 받을 수 있음(또는 --installed 기준 최신), 1 앱이 보류하는 상태, 2 사용법.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { REGISTRY_TRUST_PIN } from '../packages/engine/src/registry-pin.ts';
import { Egress, REGISTRY_ORIGIN } from '../packages/net/src/index.ts';
import { CHANNELS, decideUpdate, INITIAL_STATE, type Channel, type ReleaseManifest, type Revocation, type TrustRoot } from '../packages/updater/src/index.ts';
import { egressUpdateSources } from '../apps/desktop/src/update-sources.ts';

const { values: a } = parseArgs({ options: { channel: { type: 'string', default: 'beta' }, installed: { type: 'string', default: '0.0.0' }, download: { type: 'boolean' }, expect: { type: 'string' }, feed: { type: 'string' }, trust: { type: 'string' } } });
const channel = a.channel as Channel;
if (!(CHANNELS as readonly string[]).includes(channel) || !REGISTRY_TRUST_PIN) {
  console.error('사용법: --channel stable|beta|hotfix');
  process.exit(2);
}
const local = a.feed !== undefined;
if (local && (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(a.feed!) || !a.trust)) {
  console.error('사용법: --feed http://127.0.0.1:<포트> --trust <trust.json>');
  process.exit(2);
}
const ORIGIN = local ? a.feed! : REGISTRY_ORIGIN;
const trust: TrustRoot = local ? (JSON.parse(fs.readFileSync(a.trust!, 'utf8')) as TrustRoot) : REGISTRY_TRUST_PIN;
const egress = new Egress({ env: process.env, ...(local ? { testOrigins: { registry: ORIGIN } } : {}) });
// 앱은 엔진이 루트 서명까지 검증해 받아 둔 폐기 목록을 쓴다. 여기서는 공개 목록의 keyIds와 만료만 본다(점검용).
const revocation = async (): Promise<Revocation> => {
  const r = await egress.getRegistry('/registry/revoked_keys.json');
  const doc = r.json as { revoked?: Array<{ keyId?: unknown }>; expiresAt?: unknown } | null;
  const ids = (doc?.revoked ?? []).map((x) => x.keyId).filter((k): k is string => typeof k === 'string');
  return { keyIds: new Set(ids), fresh: typeof doc?.expiresAt === 'string' && Date.parse(doc.expiresAt) > Date.now() };
};
const sources = egressUpdateSources({ egress, trust, revocation });
const line = (k: string, v: string) => console.log(`${k.padEnd(10)} ${v}`);

let bytes: Uint8Array;
try {
  bytes = await sources.latest(channel);
} catch (e) {
  line('latest', `${ORIGIN}/releases/${channel}/latest.json 받지 못함(${(e as Error).message})`);
  process.exit(1);
}
const doc = JSON.parse(Buffer.from(bytes).toString('utf8')) as ReleaseManifest;
const transparency = await sources.transparency(bytes, channel);
const reg = await sources.registry();
const now = Date.now();
const d = decideUpdate({ doc, channel, trust: reg.trust, revocation: reg.revocation, installedVersion: a.installed!, state: INITIAL_STATE, deviceId: 'check-update-feed', transparency, now });
const left = (Date.parse(doc.expiresAt) - now) / 864e5;
line('판', `${doc.version} (${channel}, rollout ${doc.rolloutPercent}%)`);
line('기간', `${doc.releaseDate} ~ ${doc.expiresAt} (남은 ${left.toFixed(1)}일${left < 3 ? ', 곧 만료: publish-update.sh --refresh' : ''})`);
line('서명', `${doc.signature?.keyId ?? '-'}, 폐기 목록 ${reg.revocation.fresh ? '신선' : '낡음'}`);
line('투명성', transparency);
line('판정', d.action === 'hold' ? `보류 ${d.code}${d.security ? ' (보안 이벤트)' : ''}` : d.action === 'none' ? `받을 것 없음 ${d.reason}` : `받음 ${d.file.url}`);
let ok = d.action === 'download' || (d.action === 'none' && d.reason === 'up_to_date');
if (a.expect && doc.version !== a.expect) {
  line('기대', `${a.expect}인데 ${doc.version}이다(CDN 캐시 60초)`);
  ok = false;
}

for (const f of doc.files) {
  const url = `${ORIGIN}/releases/${channel}/${f.url}`;
  const head = await fetch(url, { method: 'HEAD', redirect: 'error' }).catch(() => null);
  const size = Number(head?.headers.get('content-length') ?? NaN);
  line('파일', `${f.url} ${head?.status ?? '연결 실패'} ${Number.isFinite(size) ? `${size}B` : '크기 없음'}${size === f.size ? '' : ` (매니페스트 ${f.size}B)`}`);
  if (head?.status !== 200 || size !== f.size) ok = false;
  if (a.download && head?.status === 200) {
    const t = Date.now();
    const res = await fetch(url, { redirect: 'error' });
    const h = createHash('sha512');
    let n = 0;
    for await (const c of res.body!) {
      h.update(c as Uint8Array);
      n += (c as Uint8Array).byteLength;
    }
    const same = n === f.size && h.digest('base64') === f.sha512;
    line('받기', `${n}B ${((Date.now() - t) / 1000).toFixed(1)}초, sha512 ${same ? '매니페스트와 같음' : '다름'}`);
    if (!same) ok = false;
  }
}
process.exit(ok ? 0 : 1);
