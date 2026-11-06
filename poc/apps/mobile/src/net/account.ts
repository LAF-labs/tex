// 계정 서비스 주소. 폰에는 계정 로그인이 없어 AIK_pub·기기 목록을 서버에서 받지 않는다: 페어링 3단계 검사는 PAIR_OK의
// AIK 서명 목록으로 하고, 폰의 계정 등록은 PC가 데스크톱 기기 토큰으로 대신 한다(팀장 결정 2026-11-06, D08 §4.2 3·7단계).
// 폰이 계정 서비스에 직접 부르는 것은 기기 토큰(POST /v1/device-tokens)뿐이다.
import { DEV_LOCAL, DEV_RELAY_HOST, DEV_STACK, PUBLIC_ORIGIN } from '../config';

export class AccountUnavailable extends Error {
  constructor() {
    super('account: unavailable');
  }
}

/**
 * 계정 서비스 origin(DPoP htu의 앞부분). 개발 빌드는 더미 PC(dev/dummy-pc.ts)다. 릴리스는 config PUBLIC_ORIGIN
 * (배포 때 넣는다). 비어 있으면 연결하지 않는다.
 */
export function accountOrigin(): string {
  if (DEV_STACK) return `http://${DEV_RELAY_HOST}`;
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  throw new AccountUnavailable();
}

/** 개발 빌드만: 더미 PC가 띄운 QR 텍스트(시뮬레이터에는 카메라가 없다). */
export async function devFetchQr(): Promise<string> {
  if (!DEV_LOCAL) throw new Error('dev only');
  const r = await fetch(`http://${DEV_RELAY_HOST}/dev/qr`);
  if (!r.ok) throw new Error('no qr');
  return (await r.text()).trim();
}
