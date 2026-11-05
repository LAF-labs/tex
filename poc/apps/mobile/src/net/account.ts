// 계정 서버에서 AIK_pub와 AIK 서명 기기 목록을 받는다(D08 §4.1, 페어링 3단계). 서버 값은 신뢰 앵커가 아니다:
// 폰은 목록의 모든 항목을 AIK로 검사하고(MobilePairing.scan), PAIR_OK의 AIK_pub와 같을 때만 진행한다.
// 실제 엔드포인트·폰 계정 로그인은 클라우드 트랙(services/*, M4-5) 몫이다. 여기서는 인터페이스와 개발용 구현만 둔다.
import { fromB64, type DeviceListJson } from '@sax/remote';
import { DEV_LOCAL, DEV_RELAY_HOST, PUBLIC_ORIGIN } from '../config';

export interface AccountDirectory {
  aikPub: Uint8Array;
  deviceList: DeviceListJson;
}

export interface AccountApi {
  directory(): Promise<AccountDirectory>;
}

export class AccountUnavailable extends Error {
  constructor() {
    super('account: unavailable');
  }
}

/** 시뮬레이터 개발 빌드: 더미 PC(dev/dummy-pc.ts)가 같은 값을 준다. */
const devApi: AccountApi = {
  async directory() {
    const r = await fetch(`http://${DEV_RELAY_HOST}/dev/account`);
    if (!r.ok) throw new AccountUnavailable();
    const j = (await r.json()) as { aikPub: string; deviceList: DeviceListJson };
    return { aikPub: fromB64(j.aikPub), deviceList: j.deviceList };
  },
};

const pendingApi: AccountApi = {
  async directory() {
    throw new AccountUnavailable();
  },
};

export const accountApi = (): AccountApi => (DEV_LOCAL ? devApi : pendingApi);

/**
 * 계정 서비스 origin(DPoP htu의 앞부분). 개발 빌드는 더미 PC(dev/dummy-pc.ts)다. 릴리스는 config PUBLIC_ORIGIN
 * (배포 때 넣는다). 비어 있으면 연결하지 않는다.
 */
export function accountOrigin(): string {
  if (DEV_LOCAL) return `http://${DEV_RELAY_HOST}`;
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
