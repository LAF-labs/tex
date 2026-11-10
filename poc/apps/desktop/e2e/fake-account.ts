// e2e용 메모리 계정 서비스(AccountClient)와 소프트 금고 키. fake-account-http.ts로 localhost HTTP에 내놓고 제품 클라이언트로 닿는다.
// 계정 e2e(shell-account-e2e)와 제품 경로 e2e(shell-product-e2e, 로그인이 먼저인 온보딩)가 같이 쓴다.
import { randomBytes } from 'node:crypto';
import { AIK_PURPOSES, fromB64, softNoiseStatic, softSigner, VD_PURPOSES, verifyDeviceList, x25519Public, type DesktopKeys } from '@sax/remote';
import type { AccountClient } from '../dist/remote-ports.js';

export const PASSWORD = 'mangwon-kimchi-12';

/** 서버 목록에만 있다고 치는 비밀번호(앱 번들 목록에는 없다): 서버 거부 문구를 보는 데 쓴다. */
export const SERVER_ONLY_BREACHED = 'gwangjang-bindae-3';

/** 메모리 계정 서비스: 코드 123456, 비밀번호 PASSWORD. /v1/aik는 AIK 서명 첫 목록을 실제로 검증한다. hasPassword가 거짓이면 계정 만들기 뒤 비밀번호 단계가 뜬다. */
export function fakeAccount(o: { hasPassword?: boolean } = {}) {
  const calls: string[] = [];
  let hasPw = o.hasPassword ?? true;
  let pinned: { aikPub: string; deviceId: string } | null = null;
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const client: AccountClient = {
    startEmailCode: async () => (calls.push('code'), { loginId: 'L1', expiresInSec: 600 }),
    verifyEmailCode: async (_l, code) => {
      calls.push('verify');
      if (code !== '123456') throw fail('account.code_invalid');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    passwordLogin: async (email, password) => {
      calls.push('password');
      // 틀림·없는 계정·잠금은 서버가 같은 응답을 준다(ADR-038 (d)).
      if (email !== 'owner@gyeonbon-test.example' || password !== PASSWORD) throw fail('account.credentials_invalid');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    logout: async () => void calls.push('logout'),
    me: async () => (calls.push('me'), { email: 'owner@gyeonbon-test.example', hasPassword: hasPw, reauthUntil: null, authMethod: 'email_code' }),
    setPassword: async (_s, password) => {
      calls.push('setPassword');
      if (password === SERVER_ONLY_BREACHED) throw fail('account.password_breached');
      if (password !== PASSWORD) throw fail('account.password_too_short');
      hasPw = true;
      return {};
    },
    deletePassword: async () => {
      throw fail('net.not_in_e2e');
    },
    startReauth: async () => {
      throw fail('net.not_in_e2e');
    },
    verifyReauth: async () => {
      throw fail('net.not_in_e2e');
    },
    startPasswordReset: async () => (calls.push('reset'), { resetId: 'R1', expiresInSec: 600 }),
    verifyPasswordReset: async (_r, code, password) => {
      calls.push('resetVerify');
      if (code !== '654321') throw fail('account.code_invalid');
      if (password === SERVER_ONLY_BREACHED) throw fail('account.password_breached');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    refresh: async () => {
      throw fail('account.unauthorized');
    },
    revokeRefresh: async () => {},
    logoutAll: async () => {
      throw fail('net.not_in_e2e');
    },
    deviceList: async () => (calls.push('list'), { aikPub: null, deviceList: null }),
    pinFirstDesktop: async (_s, b) => {
      calls.push('aik');
      const l = verifyDeviceList(b.deviceList, fromB64(b.aikPub));
      if (!l.ok || l.devices.length !== 1) throw fail('account.aik_signature_invalid');
      pinned = { aikPub: b.aikPub, deviceId: l.devices[0]!.deviceId };
      return { deviceId: pinned.deviceId };
    },
    deviceToken: async () => {
      throw fail('net.not_in_e2e');
    },
    acctClaim: async () => {
      throw fail('net.not_in_e2e');
    },
    enrollPhone: async () => {},
    putDeviceList: async () => {},
  };
  return { client, calls, pinned: () => pinned };
}

export function softKeys(): DesktopKeys {
  const k = () => new Uint8Array(randomBytes(32));
  const kv = k();
  return { noise: softNoiseStatic(k()), vd: softSigner(k(), VD_PURPOSES), aik: softSigner(k(), AIK_PURPOSES), kvPublic: () => x25519Public(kv) };
}
