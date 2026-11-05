// AIK 서명 산출물 검증(D08 §2.1·§4.1, D09 §2.2). 서버는 기기 목록을 보관·중계할 뿐 신뢰 앵커가 아니다(C-01).
// 그래도 서버는 AIK 서명이 없는 목록·인증서·계정 작업을 받지 않는다(위조 목록 거부, D09 §1.1 계정 행).
// 서명 입력: utf8(context) ‖ utf8(JCS(object)) (services/shared/CONTRACT.md §1).
import { fromB64, validator, verifyCtx, S } from '@sax/svc-shared';

export interface DeviceListEntry {
  device_id: string;
  role: 'desktop' | 'mobile';
  Sx: string;
  Vx: string;
  registered_at: number;
  list_version: number;
}

export interface SignedEntry {
  entry: DeviceListEntry;
  aikSig: string;
}

export interface RevokeRecord {
  device_id: string;
  revoked_at: number;
  aikSig: string;
}

export interface DeviceList {
  listVersion: number;
  entries: SignedEntry[];
  revoked: RevokeRecord[];
}

/** remote-envelope.schema.json $defs/deviceList와 같은 모양(그 스키마가 정본). */
export const deviceListSchema = {
  type: 'object',
  required: ['listVersion', 'entries', 'revoked'],
  additionalProperties: false,
  properties: {
    listVersion: { type: 'integer', minimum: 1 },
    entries: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['entry', 'aikSig'],
        additionalProperties: false,
        properties: {
          entry: {
            type: 'object',
            required: ['device_id', 'role', 'Sx', 'Vx', 'registered_at', 'list_version'],
            additionalProperties: false,
            properties: { device_id: S.uuid4, role: { enum: ['desktop', 'mobile'] }, Sx: S.b64key32, Vx: S.b64key32, registered_at: S.epochMs, list_version: { type: 'integer', minimum: 1 } },
          },
          aikSig: S.b64sig,
        },
      },
    },
    revoked: {
      type: 'array',
      maxItems: 64,
      items: { type: 'object', required: ['device_id', 'revoked_at', 'aikSig'], additionalProperties: false, properties: { device_id: S.uuid4, revoked_at: S.epochMs, aikSig: S.b64sig } },
    },
  },
} as const;

export const parseDeviceList = validator<DeviceList>(deviceListSchema);

export interface DeviceCert {
  device_id: string;
  role: 'desktop' | 'mobile';
  Sx: string;
  Vx: string;
  /** 모바일 비밀 봉인 발신 키 Km(선택) */
  Kx?: string;
  /** 하드웨어 승인 키 Px(P-256 SPKI base64, 선택, 증명된 기기만) */
  Px?: string;
  not_after: number;
}

export interface SignedCert {
  cert: DeviceCert;
  aikSig: string;
}

export const signedCertSchema = {
  type: 'object',
  required: ['cert', 'aikSig'],
  additionalProperties: false,
  properties: {
    cert: {
      type: 'object',
      required: ['device_id', 'role', 'Sx', 'Vx', 'not_after'],
      additionalProperties: false,
      properties: { device_id: S.uuid4, role: { enum: ['desktop', 'mobile'] }, Sx: S.b64key32, Vx: S.b64key32, Kx: S.b64key32, Px: { type: 'string', pattern: '^[A-Za-z0-9+/]{1,200}={0,2}$' }, not_after: S.epochMs },
    },
    aikSig: S.b64sig,
  },
} as const;

/** 계정 작업(SAX-acct-op-v1): 재활성화·RK 교체 재등록 등. ts는 서버 시각 ±5분. */
export interface AcctOp {
  op: 'device.reactivate' | 'slot.rebind_rk';
  account_id: string;
  target: string;
  ts: number;
}

export const signedOpSchema = {
  type: 'object',
  required: ['op', 'aikSig'],
  additionalProperties: false,
  properties: {
    op: {
      type: 'object',
      required: ['op', 'account_id', 'target', 'ts'],
      additionalProperties: false,
      properties: { op: { enum: ['device.reactivate', 'slot.rebind_rk'] }, account_id: { type: 'string', maxLength: 64 }, target: { type: 'string', maxLength: 128 }, ts: S.epochMs },
    },
    aikSig: S.b64sig,
  },
} as const;

const sig64 = (s: string) => fromB64(s, 64);

export function entrySigOk(aikPub: Buffer, e: SignedEntry): boolean {
  const s = sig64(e.aikSig);
  return !!s && verifyCtx('SAX-devlist-v1', e.entry, aikPub, s);
}

export function revokeSigOk(aikPub: Buffer, r: RevokeRecord): boolean {
  const s = sig64(r.aikSig);
  return !!s && verifyCtx('SAX-revoke-v1', { device_id: r.device_id, revoked_at: r.revoked_at }, aikPub, s);
}

export function certSigOk(aikPub: Buffer, c: SignedCert): boolean {
  const s = sig64(c.aikSig);
  return !!s && verifyCtx('SAX-cert-v1', c.cert, aikPub, s);
}

export const OP_SKEW_MS = 5 * 60_000;

export function opSigOk(aikPub: Buffer, o: { op: AcctOp; aikSig: string }, accountId: string, target: string, now: number): boolean {
  const s = sig64(o.aikSig);
  if (!s || o.op.account_id !== accountId || o.op.target !== target || Math.abs(o.op.ts - now) > OP_SKEW_MS) return false;
  return verifyCtx('SAX-acct-op-v1', o.op, aikPub, s);
}
