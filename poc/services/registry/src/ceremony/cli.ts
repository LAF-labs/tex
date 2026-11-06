// 레지스트리 서명 의식 CLI(CEREMONY.md). 실행: node --conditions=development services/registry/src/ceremony/cli.ts <명령> …
//   keygen        키체인에 서명 키 만들기(Secure Enclave로 감싼 블롭만 저장) → 공개키 기록
//   keygen-all    단독 모드 한 세대 12개(root·package·policy 각 3, emergency·release·timestamp 각 1)
//   pubkey        이미 있는 키의 공개키 기록
//   trust         공개키 기록들 → TRUST_ROOT_JSON(핀) + 루트 메타데이터(키 ID → 보유자 역할 표)
//   prepare       문서 → 서명 입력 바이트(.tosign)와 확인 코드
//   sign          확인 코드를 다시 입력해야 서명(Touch ID) → 서명 기록
//   collect       서명 기록들 → signatures[](서로 다른 핀 키 정족수)
//   timestamp     타임스탬프 서명 기록 → 문서 timestamp
//   check         완성 문서를 레지스트리 게시 관문 규칙으로 확인
//   backup-export 고른 키를 강한 암호(scrypt + ChaCha20-Poly1305)로 잠근 오프라인 파일 1개로
//   backup-verify 백업 파일을 열어 핀과 같은지만 본다(들여오지 않음)
//   backup-import 백업 파일 → 이 맥의 키체인(Secure Enclave로 다시 감싼다)
// 시드는 서명 때 Node로 오지 않는다(도우미 안에서 서명). 백업 내보내기·들여오기만 예외이고 버퍼를 바로 0으로 덮는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { countSignatures, verifyIndex, verifyPolicy, verifyRelease, verifyRevoked, verifyStatus, type Role, type TrustRoot } from '../verify.ts';
import { attachTimestamp, buildTrust, collectSignatures, ROLE_COUNTS, signWithBackend, type KeyRecord, type SignatureRecord, type TrustMode, type TrustPin } from './collect.ts';
import { CeremonyError, confirmCode, DOC_KINDS, prepare, quorumFor, signingBytes, SIGNER_ROLES, type DocKind } from './content.ts';
import { MacKeychainBackend, type KeyStoreBackend } from './device.ts';
import { openBackup, sealBackup, wipeEntries } from './wrap.ts';

export const DEFAULT_HELPER = path.join(os.homedir(), '.sax', 'bin', 'sax-keychain');

export interface CliDeps {
  backend(o: { helper: string }): KeyStoreBackend;
  /** 암호 입력(화면에 보이지 않게). confirm이면 두 번 묻고 같아야 한다. */
  passphrase(prompt: string, confirm: boolean): Promise<string>;
  out(line: string): void;
  read(path: string): Buffer;
  write(path: string, data: string | Buffer): void;
  now(): Date;
}

/** 터미널에서 메아리 없이 한 줄 읽기. 터미널이 아니면 거부(파이프·파일로 암호를 넘기지 않는다). */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new CeremonyError('ceremony.no_tty', '암호는 터미널에서만 받는다');
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let s = '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const on = (b: Buffer) => {
        for (const ch of b.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', on);
            process.stderr.write('\n');
            return resolve(s);
          }
          if (ch === '\u0003') {
            stdin.off('data', on);
            return reject(new CeremonyError('ceremony.cancelled'));
          }
          if (ch === '\u007f' || ch === '\b') s = [...s].slice(0, -1).join('');
          else s += ch;
        }
      };
      stdin.on('data', on);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

const defaultDeps: CliDeps = {
  backend: (o) => new MacKeychainBackend({ helper: o.helper }),
  passphrase: async (prompt, confirm) => {
    const a = await readHidden(prompt);
    if (confirm && (await readHidden('한 번 더: ')) !== a) throw new CeremonyError('ceremony.passphrase_mismatch');
    return a;
  },
  out: (l) => process.stdout.write(`${l}\n`),
  read: (p) => fs.readFileSync(p),
  write: (p, d) => fs.writeFileSync(p, d, { flag: 'wx', mode: 0o600 }), // 이미 있는 파일은 덮지 않는다
  now: () => new Date(),
};

function parse(argv: readonly string[]): { flags: Map<string, string[]>; pos: string[] } {
  const flags = new Map<string, string[]>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new CeremonyError('ceremony.usage', `--${k} 값 없음`);
      flags.set(k, [...(flags.get(k) ?? []), v]);
      i++;
    } else pos.push(a);
  }
  return { flags, pos };
}

const roleOf = (keyId: string): Role => {
  const r = keyId.split('-')[0] as Role;
  if (!(r in ROLE_COUNTS) || !/^[a-z]+-[0-9]+$/.test(keyId)) throw new CeremonyError('ceremony.usage', `keyId ${keyId}`);
  return r;
};

/** 단독 모드 한 세대의 keyId 12개(D09 §8.2 역할별 개수). timestamp는 Phase 1에 같은 맥에 둔다(CEREMONY.md §2). */
export const SOLO_KEY_IDS = (Object.entries(ROLE_COUNTS) as Array<[Role, number]>).flatMap(([r, n]) => Array.from({ length: n }, (_, i) => `${r}-${i + 1}`));

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
  const backend = () => deps.backend({ helper: one('helper', false) || DEFAULT_HELPER });
  const record = (keyId: string, pub: Buffer): KeyRecord => ({ keyId, role: roleOf(keyId), publicKey: pub.toString('base64'), holder: one('holder'), backend: 'macos-se' });
  const revokedOf = () => (flags.has('revoked') ? new Set(json<{ revoked: Array<{ keyId: string }> }>(one('revoked')).revoked.map((r) => r.keyId)) : new Set<string>());

  switch (cmd) {
    case 'keygen': {
      const keyId = one('key-id');
      roleOf(keyId);
      const pub = await backend().generate(keyId);
      writeJson(one('out'), record(keyId, pub));
      deps.out(`키 ${keyId}(${roleOf(keyId)}) 만듦: ${pub.toString('base64')}`);
      return 0;
    }
    case 'keygen-all': {
      const dir = one('out-dir');
      const b = backend();
      for (const keyId of SOLO_KEY_IDS) {
        const pub = await b.generate(keyId);
        writeJson(path.join(dir, `${keyId}.json`), record(keyId, pub));
        deps.out(`키 ${keyId} 만듦: ${pub.toString('base64')}`);
      }
      deps.out(`${SOLO_KEY_IDS.length}개. 다음: backup-export로 오프라인 백업 1개를 만든다(CEREMONY.md §4)`);
      return 0;
    }
    case 'pubkey': {
      const keyId = one('key-id');
      writeJson(one('out'), record(keyId, await backend().publicKey(keyId)));
      return 0;
    }
    case 'trust': {
      const keyEpoch = Number(one('key-epoch'));
      const mode = (one('mode', false) || 'solo') as TrustMode;
      const recs = pos.map((p) => json<KeyRecord>(p));
      const { trust, metadata } = buildTrust(recs, keyEpoch, deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z'), mode);
      writeJson(one('out-trust'), trust);
      writeJson(one('out-metadata'), metadata);
      const p = prepare('trust_root', metadata);
      deps.out(`TRUST_ROOT_JSON keyEpoch ${keyEpoch}(${mode}), 키 ${recs.length}개. 루트 메타데이터 확인 코드 ${confirmCode(p.sha256)} (sha256 ${p.sha256})`);
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
      const keyId = one('key-id');
      const role = (one('role', false) || roleOf(keyId)) as Role;
      const p = prepare(kind, json(pos[0] ?? ''), part);
      deps.out(p.summary);
      deps.out(`sha256 ${p.sha256}`);
      let expected: string | undefined;
      if (flags.has('trust')) expected = json<TrustPin>(one('trust')).keys[role]?.[keyId];
      else if (flags.has('key-record')) expected = json<KeyRecord>(one('key-record')).publicKey;
      if (!expected) throw new CeremonyError('ceremony.usage', '--trust 또는 --key-record로 기대 공개키를 준다');
      const b = backend();
      deps.out(`${b.describe()} ${keyId}: Touch ID 창의 확인 코드가 위 sha256 앞부분과 같은지 보고 인증하세요`);
      const rec = await signWithBackend(b, { kind, part, bytes: p.bytes, role, keyId, confirm: one('confirm'), expectedPublicKey: expected });
      writeJson(one('out'), rec);
      deps.out(`서명 기록 ${keyId} → ${one('out')}`);
      return 0;
    }
    case 'collect': {
      const kind = kindOf();
      const [docPath, ...sigPaths] = pos;
      const r = collectSignatures(kind, json(docPath ?? ''), sigPaths.map((p) => json<SignatureRecord>(p)), json<TrustPin>(one('trust')), revokedOf());
      writeJson(one('out'), r.doc);
      deps.out(`${kind}: ${r.role} ${r.keyIds.join(', ')} (${r.keyIds.length}/${quorumFor(r.role)}) → ${one('out')}`);
      return 0;
    }
    case 'timestamp': {
      const kind = kindOf();
      const [docPath, sigPath] = pos;
      writeJson(one('out'), attachTimestamp(kind, json(docPath ?? ''), json<SignatureRecord>(sigPath ?? ''), json<TrustPin>(one('trust'))));
      deps.out(`${kind}: timestamp 붙임 → ${one('out')}`);
      return 0;
    }
    case 'check': {
      const kind = kindOf();
      const doc = json<Record<string, unknown>>(pos[0] ?? '');
      const trust = json<TrustRoot>(one('trust'));
      const revoked = revokedOf();
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
        deps.out(`검증 실패: ${(e as { code?: string }).code ?? 'ceremony.check_failed'}`);
        return 2;
      }
      deps.out(`${kind}: 게시 관문 규칙 통과`);
      return 0;
    }
    case 'backup-export': {
      const ids = pos.length ? pos : SOLO_KEY_IDS;
      for (const id of ids) roleOf(id);
      const pass = await deps.passphrase('백업 암호(20자 이상, 단어 5개 이상 권장): ', true);
      const entries = await backend().exportSeeds(ids);
      try {
        deps.write(one('out'), sealBackup(entries, pass, deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z')));
      } finally {
        wipeEntries(entries);
      }
      deps.out(`백업 ${ids.length}개 → ${one('out')}. 오프라인 매체에 옮기고 backup-verify로 확인하세요`);
      return 0;
    }
    case 'backup-verify':
    case 'backup-import': {
      const file = deps.read(one('in')).toString('utf8');
      const trust = flags.has('trust') ? json<TrustPin>(one('trust')) : null;
      const entries = openBackup(file, await deps.passphrase('백업 암호: ', false));
      try {
        if (trust) for (const e of entries) if (trust.keys[roleOf(e.keyId)]?.[e.keyId] !== e.pub) throw new CeremonyError('ceremony.backup_not_pinned', e.keyId);
        if (cmd === 'backup-verify') {
          const pinned = trust ? Object.values(trust.keys).reduce((n, ks) => n + Object.keys(ks ?? {}).length, 0) : null;
          deps.out(`백업 열림: 키 ${entries.length}개${trust ? `, 핀과 같음(핀 ${pinned}개)` : ''}`);
          return 0;
        }
        const b = backend();
        for (const e of entries) {
          const pub = await b.importSeed(e.keyId, e.seed);
          if (pub.toString('base64') !== e.pub) throw new CeremonyError('ceremony.import_mismatch', e.keyId);
          deps.out(`들여옴 ${e.keyId}`);
        }
        return 0;
      } finally {
        wipeEntries(entries);
      }
    }
  }
  deps.out('명령: keygen | keygen-all | pubkey | trust | prepare | sign | collect | timestamp | check | backup-export | backup-verify | backup-import (CEREMONY.md)');
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
