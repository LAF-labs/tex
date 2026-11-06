// 서명 의식: 공개키 기록 → 핀(TRUST_ROOT_JSON)·루트 메타데이터, 보유자 서명 → signatures[] 모으기.
// 모으는 쪽은 서버·엔진과 같은 규칙으로 센다(services/registry countSignatures): 그 역할의 핀 키, 서로 다른 keyId, alg ed25519.
// 의식 도구는 더 엄격하다: 같은 키 두 번·폐기 키·다른 역할 키·검증 실패 서명은 세지 않는 것이 아니라 거부한다(잘못 모은 것을 바로 알린다).
/** 앱 핀(엔진 TrustPin·@sax/updater TrustRoot·tests/fixtures/registry/trust.json과 같은 모양). */
export interface TrustPin {
  keyEpoch: number;
  keys: Partial<Record<Role, Record<string, string>>>;
}
import { countSignatures, type Role, type Sig, type TrustRoot } from '../verify.ts';
import { CeremonyError, confirmCode, quorumFor, sha256, signingBytes, SIGNER_ROLES, TIMESTAMPED, timestampBytes, type DocKind } from './content.ts';
import { edVerifyRaw, type SigningBackend } from './device.ts';

/** 공개키 기록(keygen 결과). 비밀은 없다. */
export interface KeyRecord {
  keyId: string;
  role: Role;
  /** 표준 base64 32바이트 */
  publicKey: string;
  /** 보유자 역할 이름(실명 아님, 예 "단독 보유자", "보유자 A(운영)", "릴리스 보유자") */
  holder: string;
  /** 키가 사는 곳: macos-se(키체인 + Secure Enclave 감싸기, 단독 모드), yubikey-piv(승격 뒤), server-env(레지스트리 서버 비밀값, 타임스탬프 키) */
  backend: 'macos-se' | 'yubikey-piv' | 'server-env';
  /** yubikey-piv만: 슬롯·일련번호·증명(attestation) 확인 여부 */
  slot?: string | null;
  serial?: number | null;
  attested?: boolean;
}

/** solo = Phase 1 단독 보유(ADR-037), quorum = 보유자 3명 + 릴리스 1명(D09 §8.2). */
export type TrustMode = 'solo' | 'quorum';

/** 역할별 키 수(D09 §8.2). release는 엔진 핀에 없고 main 업데이터가 쓴다. */
export const ROLE_COUNTS: Record<Role, number> = { root: 3, package: 3, policy: 3, emergency: 1, timestamp: 1, release: 1 };
const KEY_ID = /^(root|package|policy|emergency|timestamp|release)-[0-9]+$/;

export interface RootMetadata {
  kind: 'sax.trust-root/v1';
  keyEpoch: number;
  createdAt: string;
  keys: TrustPin['keys'];
  /** keyId → 보유자 역할 표(D09 §8.2 "루트 메타데이터에 키 ID → 보유자 역할 표를 공개한다") */
  /** 보유 형태(solo면 모든 키를 한 사람이 한 맥에 갖는다. 2-of-3은 키 분리일 뿐 사람 분리가 아니다) */
  mode: TrustMode;
  holders: Array<{ keyId: string; role: Role; holder: string; backend: KeyRecord['backend'] }>;
  signatures: Sig[];
}

/**
 * 공개키 기록 → 핀과 루트 메타데이터. 어긋나면 던진다.
 * - 역할별 개수, keyId 모양(역할-번호), keyId·공개키 중복 없음(역할 사이에도)
 * - quorum: root·package·policy는 역할마다 보유자 3명이 서로 다르다(1인 1키, D09 §8.2), 릴리스 보유자는 운영 키를 갖지 않는다(ADR-028),
 *   yubikey-piv 키는 장치 증명이 있어야 한다
 * - solo: 보유자 한 명(ADR-037). 사람 분리 검사를 하지 않는다
 * (엔진 trustRootsFromPin이 받는 모양이다: 시험이 대조한다)
 */
export function buildTrust(records: readonly KeyRecord[], keyEpoch: number, createdAt: string, mode: TrustMode = 'solo'): { trust: TrustPin; metadata: RootMetadata } {
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 1) throw new CeremonyError('ceremony.trust_invalid', 'keyEpoch');
  const ids = new Set<string>();
  const pubs = new Set<string>();
  const keys: TrustPin['keys'] = {};
  for (const r of records) {
    if (!KEY_ID.test(r.keyId) || !r.keyId.startsWith(`${r.role}-`)) throw new CeremonyError('ceremony.trust_invalid', `keyId ${r.keyId}`);
    const raw = Buffer.from(r.publicKey, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== r.publicKey) throw new CeremonyError('ceremony.trust_invalid', `publicKey ${r.keyId}`);
    if (ids.has(r.keyId)) throw new CeremonyError('ceremony.trust_invalid', `keyId 중복 ${r.keyId}`);
    if (pubs.has(r.publicKey)) throw new CeremonyError('ceremony.trust_invalid', `같은 공개키 두 번 ${r.keyId}`);
    if (!['macos-se', 'yubikey-piv', 'server-env'].includes(r.backend)) throw new CeremonyError('ceremony.trust_invalid', `backend ${r.keyId}`);
    // 타임스탬프 키는 서버 온라인 키다(ADR-037 결정 (3), D09 §8.2). 다른 역할 키는 서버에 두지 않는다.
    if ((r.role === 'timestamp') !== (r.backend === 'server-env')) throw new CeremonyError('ceremony.trust_invalid', `${r.keyId}: 타임스탬프 키만 서버 비밀값`);
    if (r.backend === 'yubikey-piv' && !r.attested) throw new CeremonyError('ceremony.trust_invalid', `장치 증명 없음 ${r.keyId}`);
    if (typeof r.holder !== 'string' || !r.holder.trim()) throw new CeremonyError('ceremony.trust_invalid', `보유자 없음 ${r.keyId}`);
    ids.add(r.keyId);
    pubs.add(r.publicKey);
    (keys[r.role] ??= {})[r.keyId] = r.publicKey;
  }
  for (const [role, n] of Object.entries(ROLE_COUNTS) as Array<[Role, number]>) {
    const got = Object.keys(keys[role] ?? {}).length;
    if (got !== n) throw new CeremonyError('ceremony.trust_invalid', `${role} ${got}/${n}`);
  }
  if (mode === 'quorum') {
    for (const role of ['root', 'package', 'policy'] as const) {
      const holders = new Set(records.filter((r) => r.role === role).map((r) => r.holder));
      if (holders.size !== 3) throw new CeremonyError('ceremony.trust_invalid', `${role} 보유자가 3명이 아님`);
    }
    const releaseHolder = records.find((r) => r.role === 'release')!.holder;
    if (records.some((r) => ['root', 'package', 'policy'].includes(r.role) && r.holder === releaseHolder)) throw new CeremonyError('ceremony.trust_invalid', '릴리스 보유자가 운영 키를 가짐');
  } else if (mode !== 'solo') throw new CeremonyError('ceremony.trust_invalid', `mode ${String(mode)}`);
  const sorted: TrustPin['keys'] = {};
  for (const role of Object.keys(ROLE_COUNTS) as Role[]) sorted[role] = Object.fromEntries(Object.entries(keys[role]!).sort(([a], [b]) => a.localeCompare(b)));
  const trust: TrustPin = { keyEpoch, keys: sorted };
  const holders = [...records].sort((a, b) => a.keyId.localeCompare(b.keyId)).map((r) => ({ keyId: r.keyId, role: r.role, holder: r.holder, backend: r.backend }));
  return { trust, metadata: { kind: 'sax.trust-root/v1', keyEpoch, createdAt, mode, keys: sorted, holders, signatures: [] } };
}

// ---- 보유자 서명 ----

/** 보유자 한 명의 서명 결과 파일. collect가 읽는다. sha256은 서명 입력의 다이제스트(엉뚱한 문서 서명을 모을 때 바로 걸린다). */
export interface SignatureRecord extends Sig {
  kind: DocKind;
  part: 'content' | 'timestamp';
  sha256: string;
}

/**
 * 백엔드로 서명한다. confirm은 화면에 보인 확인 코드(confirmCode(sha256))를 서명자가 다시 입력한 값이어야 한다(문서를 맞춰 봤다는 뜻).
 * 단독 모드에서는 prepare가 보인 코드를 sign에 다시 넣는다(복사·붙여넣기가 아니라 눈으로 맞춰 본다). Touch ID 창에도 같은 코드가 뜬다.
 * expectedPublicKey(핀 또는 공개키 기록)가 있으면 백엔드의 그 keyId 공개키와 같아야 한다. 서명은 그 공개키로 다시 검증한다.
 */
export async function signWithBackend(backend: SigningBackend, o: { kind: DocKind; part: 'content' | 'timestamp'; bytes: Buffer; role: Role; keyId: string; confirm: string; expectedPublicKey?: string }): Promise<SignatureRecord> {
  const sha = sha256(o.bytes);
  if (o.confirm.trim().toLowerCase() !== confirmCode(sha)) throw new CeremonyError('ceremony.confirm_mismatch');
  if (o.part === 'timestamp' ? o.role !== 'timestamp' : !SIGNER_ROLES[o.kind].includes(o.role)) throw new CeremonyError('ceremony.role_not_allowed', `${o.kind}/${o.part}: ${o.role}`);
  if (!o.keyId.startsWith(`${o.role}-`)) throw new CeremonyError('ceremony.role_not_allowed', o.keyId);
  const pub = await backend.publicKey(o.keyId);
  if (o.expectedPublicKey && !pub.equals(Buffer.from(o.expectedPublicKey, 'base64'))) throw new CeremonyError('ceremony.wrong_key', o.keyId);
  const sig = await backend.sign(o.keyId, o.bytes, confirmCode(sha));
  if (!edVerifyRaw(pub, o.bytes, sig)) throw new CeremonyError('ceremony.signature_invalid');
  return { keyId: o.keyId, alg: 'ed25519', sig: sig.toString('base64url'), kind: o.kind, part: o.part, sha256: sha };
}

// ---- 모으기 ----

const keyEpochOf = (kind: DocKind, doc: Record<string, unknown>) => (kind === 'release' ? undefined : kind === 'root_change' ? undefined : doc.keyEpoch);

/**
 * 내용 서명을 모아 문서에 넣는다(배열 종류는 signatures, release는 signature, root_change는 rootChange.signatures).
 * 역할: 서명이 모두 긴급 키면 emergency(정확히 1개, status·policy만), 아니면 그 종류의 첫 역할. 정족수 = 서로 다른 핀 키 수.
 */
export function collectSignatures(kind: DocKind, doc: Record<string, unknown>, records: readonly SignatureRecord[], trust: TrustPin, revoked: ReadonlySet<string> = new Set()): { doc: Record<string, unknown>; role: Role; keyIds: string[] } {
  const bytes = signingBytes(kind, doc);
  const sha = sha256(bytes);
  const ep = keyEpochOf(kind, doc);
  if (ep !== undefined && ep !== trust.keyEpoch) throw new CeremonyError('ceremony.key_epoch_mismatch');
  if (!records.length) throw new CeremonyError('ceremony.quorum_short', '0');
  const allEmergency = records.every((r) => r.keyId.startsWith('emergency-'));
  const role: Role = allEmergency ? 'emergency' : SIGNER_ROLES[kind][0]!;
  if (!SIGNER_ROLES[kind].includes(role)) throw new CeremonyError('ceremony.role_not_allowed', `${kind}: ${role}`);
  if (records.length > 3) throw new CeremonyError('ceremony.too_many_signatures');
  const pinned = trust.keys[role] ?? {};
  const seen = new Set<string>();
  for (const r of records) {
    if (r.kind !== kind || r.part !== 'content' || r.sha256 !== sha) throw new CeremonyError('ceremony.wrong_document', r.keyId);
    if (r.alg !== 'ed25519' || !Object.hasOwn(pinned, r.keyId)) throw new CeremonyError('ceremony.key_not_pinned', `${r.keyId}(${role})`);
    if (revoked.has(r.keyId)) throw new CeremonyError('ceremony.key_revoked', r.keyId);
    if (seen.has(r.keyId)) throw new CeremonyError('ceremony.duplicate_signer', r.keyId);
    if (!edVerifyRaw(Buffer.from(pinned[r.keyId]!, 'base64'), bytes, Buffer.from(r.sig, 'base64url'))) throw new CeremonyError('ceremony.signature_invalid', r.keyId);
    seen.add(r.keyId);
  }
  const need = quorumFor(role);
  if (role === 'emergency' && records.length !== 1) throw new CeremonyError('ceremony.role_not_allowed', '긴급 키는 단독');
  if (seen.size < need) throw new CeremonyError('ceremony.quorum_short', `${seen.size}/${need}`);
  const sigs: Sig[] = [...records].sort((a, b) => a.keyId.localeCompare(b.keyId)).map((r) => ({ keyId: r.keyId, alg: 'ed25519', sig: r.sig }));
  // 서버·엔진과 같은 셈으로 다시 확인(같은 핀·같은 바이트)
  if (countSignatures(bytes, sigs, role, trust as unknown as TrustRoot, revoked).valid.length < need) throw new CeremonyError('ceremony.quorum_short', 'server-rule');
  const out = structuredClone(doc);
  if (kind === 'release') out.signature = sigs[0];
  else if (kind === 'root_change') (out.rootChange as Record<string, unknown>).signatures = sigs;
  else out.signatures = sigs;
  return { doc: out, role, keyIds: sigs.map((s) => s.keyId) };
}

/** 타임스탬프 서명(정책·status·폐기 목록)을 넣는다. 내용 서명을 먼저 모은 뒤에 한다(내용 다이제스트는 signatures·timestamp와 무관하다). */
export function attachTimestamp(kind: DocKind, doc: Record<string, unknown>, record: SignatureRecord, trust: TrustPin): Record<string, unknown> {
  if (!TIMESTAMPED.has(kind)) throw new CeremonyError('ceremony.no_timestamp', kind);
  const bytes = timestampBytes(kind, doc);
  const pinned = trust.keys.timestamp ?? {};
  if (record.part !== 'timestamp' || record.kind !== kind || record.sha256 !== sha256(bytes)) throw new CeremonyError('ceremony.wrong_document', record.keyId);
  if (!Object.hasOwn(pinned, record.keyId) || !edVerifyRaw(Buffer.from(pinned[record.keyId]!, 'base64'), bytes, Buffer.from(record.sig, 'base64url'))) throw new CeremonyError('ceremony.signature_invalid', record.keyId);
  return { ...structuredClone(doc), timestamp: { keyId: record.keyId, alg: 'ed25519', sig: record.sig } };
}
