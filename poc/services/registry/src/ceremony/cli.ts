// 레지스트리 서명 의식 CLI(CEREMONY.md). 실행: node --conditions=development services/registry/src/ceremony/cli.ts <명령> …
//   pubkey     장치 슬롯 공개키 + 증명 검사 → 공개키 기록(JSON)
//   trust      공개키 기록들 → TRUST_ROOT_JSON(핀) + 루트 메타데이터(키 ID → 보유자 역할 표, 루트 2-of-3 서명 대상)
//   prepare    문서 → 서명 입력 바이트(.tosign)와 확인 코드(진행자가 읽는다)
//   sign       보유자가 자기 장치로 서명 → 서명 기록(JSON). 확인 코드를 입력해야 장치에 넘긴다
//   collect    서명 기록들 → 문서 signatures[](서로 다른 핀 키 정족수)
//   timestamp  타임스탬프 서명 기록 → 문서 timestamp(정책·status·폐기 목록)
//   check      완성 문서를 레지스트리 게시 관문과 같은 검증기로 확인
// 개인키·PIN은 이 도구를 지나가지 않는다(장치 안·pkcs11-tool 프롬프트).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { countSignatures, verifyIndex, verifyPolicy, verifyRelease, verifyRevoked, verifyStatus, type Role, type TrustRoot } from '../verify.ts';
import { verifyAttestation } from './attest.ts';
import { attachTimestamp, buildTrust, collectSignatures, signWithDevice, type KeyRecord, type SignatureRecord, type TrustPin } from './collect.ts';
import { CeremonyError, confirmCode, DOC_KINDS, prepare, quorumFor, signingBytes, SIGNER_ROLES, type DocKind } from './content.ts';
import { rawEd25519FromSpki, ROLE_SLOT, YubiKeyPiv, type SigningDevice } from './device.ts';

export interface CliDeps {
  /** 장치 만들기(시험은 가짜 장치) */
  device(o: { module?: string; serial?: string }): SigningDevice;
  out(line: string): void;
  read(path: string): Buffer;
  write(path: string, data: string | Buffer): void;
  now(): Date;
}

const defaultDeps: CliDeps = {
  device: (o) => {
    if (!o.module) throw new CeremonyError('ceremony.usage', '--module <libykcs11 경로>가 필요하다');
    return new YubiKeyPiv({ module: o.module, serial: o.serial });
  },
  out: (l) => process.stdout.write(`${l}\n`),
  read: (p) => fs.readFileSync(p),
  write: (p, d) => fs.writeFileSync(p, d, { flag: 'wx' }), // 이미 있는 파일은 덮지 않는다
  now: () => new Date(),
};

function parse(argv: readonly string[]): { flags: Map<string, string[]>; pos: string[] } {
  const flags = new Map<string, string[]>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) {
        flags.set(k, ['true']);
        continue;
      }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new CeremonyError('ceremony.usage', `--${k} 값 없음`);
      flags.set(k, [...(flags.get(k) ?? []), v]);
      i++;
    } else pos.push(a);
  }
  return { flags, pos };
}

export async function main(argv: readonly string[], deps: CliDeps = defaultDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const { flags, pos } = parse(rest);
  const one = (k: string, required = true): string => {
    const v = flags.get(k);
    if (!v?.length) {
      if (required) throw new CeremonyError('ceremony.usage', `--${k}`);
      return '';
    }
    if (v.length > 1) throw new CeremonyError('ceremony.usage', `--${k} 두 번`);
    return v[0]!;
  };
  const many = (k: string) => flags.get(k) ?? [];
  const json = <T>(p: string): T => {
    try {
      return JSON.parse(deps.read(p).toString('utf8')) as T;
    } catch {
      throw new CeremonyError('ceremony.file_invalid', p);
    }
  };
  const kindOf = (): DocKind => {
    const k = one('kind') as DocKind;
    if (!DOC_KINDS.includes(k)) throw new CeremonyError('ceremony.kind_unknown', k);
    return k;
  };
  const partOf = () => (one('part', false) || 'content') as 'content' | 'timestamp';
  const writeJson = (p: string, v: unknown) => deps.write(p, `${JSON.stringify(v, null, 2)}\n`);

  switch (cmd) {
    case 'pubkey': {
      const role = one('role') as Role;
      const keyId = one('key-id');
      const holder = one('holder');
      const out = one('out');
      if (role === 'timestamp') {
        // 타임스탬프 키는 서버 HSM(D09 §8.2). 공개키 PEM을 받고 증명 없이 기록한다.
        const pub = rawEd25519FromSpki(deps.read(one('pubkey-pem')).toString('utf8'));
        const rec: KeyRecord = { keyId, role, publicKey: pub.toString('base64'), holder, slot: null, serial: null, firmware: null, attested: false };
        writeJson(out, rec);
        deps.out(`공개키 기록 ${keyId}(timestamp, 증명 없음): ${rec.publicKey}`);
        return 0;
      }
      const slot = ROLE_SLOT[role];
      if (!slot) throw new CeremonyError('ceremony.usage', `role ${role}`);
      const dev = deps.device({ module: one('module', false) || undefined, serial: one('serial', false) || undefined });
      const pub = await dev.publicKey(slot);
      const roots = many('yubico-root').map((p) => deps.read(p).toString('utf8'));
      const att = await dev.attestation(slot);
      const r = verifyAttestation({ ...att, roots, intermediates: many('yubico-intermediate').map((p) => deps.read(p).toString('utf8')), expectPublicKey: pub, now: deps.now() });
      const rec: KeyRecord = { keyId, role, publicKey: pub.toString('base64'), holder, slot, serial: r.serial, firmware: r.firmware, attested: true };
      writeJson(out, rec);
      deps.out(`공개키 기록 ${keyId}(${role}, 슬롯 ${slot}, 장치 #${r.serial ?? '?'}, 펌웨어 ${r.firmware ?? '?'}, PIN ${r.pinPolicy}·터치 ${r.touchPolicy}): ${rec.publicKey}`);
      return 0;
    }
    case 'trust': {
      const keyEpoch = Number(one('key-epoch'));
      const recs = pos.map((p) => json<KeyRecord>(p));
      const { trust, metadata } = buildTrust(recs, keyEpoch, deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z'));
      writeJson(one('out-trust'), trust);
      writeJson(one('out-metadata'), metadata);
      const p = prepare('trust_root', metadata);
      deps.out(`TRUST_ROOT_JSON keyEpoch ${keyEpoch}, 키 ${recs.length}개. 루트 메타데이터 확인 코드 ${confirmCode(p.sha256)} (sha256 ${p.sha256})`);
      return 0;
    }
    case 'prepare': {
      const kind = kindOf();
      const p = prepare(kind, json(pos[0] ?? ''), partOf());
      if (flags.has('out')) deps.write(one('out'), p.bytes);
      deps.out(p.summary);
      deps.out(`서명 입력 ${p.bytes.length}B sha256 ${p.sha256}`);
      deps.out(`확인 코드 ${confirmCode(p.sha256)} — 서명할 역할: ${partOf() === 'timestamp' ? 'timestamp' : SIGNER_ROLES[kind].join('|')}`);
      return 0;
    }
    case 'sign': {
      const kind = kindOf();
      const part = partOf();
      const role = one('role') as Role;
      const keyId = one('key-id');
      const doc = json(pos[0] ?? '');
      const p = prepare(kind, doc, part);
      deps.out(p.summary);
      deps.out(`sha256 ${p.sha256}`);
      // 기대 공개키: 핀(trust) 또는 그 보유자의 공개키 기록
      let expected: string | undefined;
      if (flags.has('trust')) expected = json<TrustPin>(one('trust')).keys[role]?.[keyId];
      else if (flags.has('key-record')) expected = json<KeyRecord>(one('key-record')).publicKey;
      if (!expected) throw new CeremonyError('ceremony.usage', '--trust 또는 --key-record로 기대 공개키를 준다');
      const dev = deps.device({ module: one('module', false) || undefined, serial: one('serial', false) || undefined });
      deps.out(`${dev.describe()} 슬롯 ${ROLE_SLOT[role] ?? '?'}: PIN을 입력하고 장치를 터치하세요`);
      const rec = await signWithDevice(dev, { kind, part, bytes: p.bytes, role, keyId, confirm: one('confirm'), expectedPublicKey: expected });
      writeJson(one('out'), rec);
      deps.out(`서명 기록 ${keyId} → ${one('out')}`);
      return 0;
    }
    case 'collect': {
      const kind = kindOf();
      const [docPath, ...sigPaths] = pos;
      const trust = json<TrustPin>(one('trust'));
      const revoked = flags.has('revoked') ? new Set(json<{ revoked: Array<{ keyId: string }> }>(one('revoked')).revoked.map((r) => r.keyId)) : new Set<string>();
      const r = collectSignatures(kind, json(docPath ?? ''), sigPaths.map((p) => json<SignatureRecord>(p)), trust, revoked);
      writeJson(one('out'), r.doc);
      deps.out(`${kind}: ${r.role} ${r.keyIds.join(', ')} (${r.keyIds.length}/${quorumFor(r.role)}) → ${one('out')}`);
      return 0;
    }
    case 'timestamp': {
      const kind = kindOf();
      const [docPath, sigPath] = pos;
      const doc = attachTimestamp(kind, json(docPath ?? ''), json<SignatureRecord>(sigPath ?? ''), json<TrustPin>(one('trust')));
      writeJson(one('out'), doc);
      deps.out(`${kind}: timestamp 붙임 → ${one('out')}`);
      return 0;
    }
    case 'check': {
      const kind = kindOf();
      const doc = json<Record<string, unknown>>(pos[0] ?? '');
      const trust = json<TrustRoot>(one('trust'));
      const revoked = flags.has('revoked') ? new Set(json<{ revoked: Array<{ keyId: string }> }>(one('revoked')).revoked.map((r) => r.keyId)) : new Set<string>();
      const now = deps.now().getTime();
      const channel = (doc.channel ?? 'stable') as 'stable';
      try {
        if (kind === 'revoked_keys') verifyRevoked(doc as never, trust, null, now);
        else if (kind === 'status') verifyStatus(doc as never, trust, revoked, null, now);
        else if (kind === 'policy') verifyPolicy(doc as never, trust, revoked, null, now);
        else if (kind === 'index') verifyIndex(doc as never, channel, trust, revoked, null, now);
        else if (kind === 'release') verifyRelease(doc as never, channel, trust, revoked, null, now);
        else {
          const sigs = kind === 'root_change' ? (doc.rootChange as { signatures?: unknown } | undefined)?.signatures : doc.signatures;
          const role = SIGNER_ROLES[kind][0]!;
          if (countSignatures(signingBytes(kind, doc), sigs, role, trust, revoked).valid.length < quorumFor(role)) throw new CeremonyError('registry.signature_insufficient');
        }
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'ceremony.check_failed';
        deps.out(`검증 실패: ${code}`);
        return 2;
      }
      deps.out(`${kind}: 게시 관문 규칙 통과`);
      return 0;
    }
  }
  deps.out('명령: pubkey | trust | prepare | sign | collect | timestamp | check (CEREMONY.md)');
  return 64;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${e instanceof CeremonyError ? e.message : 'ceremony.failed'}\n`);
      process.exit(1);
    },
  );
}
