// 앱 상태 파일(페어링 기록·기기 목록·IK 타임스탬프·현금매출 기록). fileKey로 XChaCha20-Poly1305 봉인해 sax/state.bin에 둔다.
import { File } from 'expo-file-system';
import { fromUtf8, utf8, xOpen, xSeal, type DeviceListJson, type SignedCert } from '@sax/remote';
import { ROOT, writeProtected } from './files';

const AD = utf8('SAX-mobile-state-v1');
const FILE = new File(ROOT, 'state.bin');

export interface PairState {
  pairId: string;
  desktopStatic: string;
  desktopVd: string;
  desktopDeviceId: string;
  kvPub: string;
  aikPub: string;
  /** AIK 서명 기기 인증서. 계정 서비스 POST /v1/device-tokens에 그대로 보낸다(packages/remote requestDeviceToken). */
  cert: SignedCert;
  certNotAfter: number;
  mbxId: string;
  tokWrite: string;
  mbxEpoch: number;
  relayHost: string;
  pairedAt: number;
}

export interface CashRecord {
  day: string;
  amount: number;
  msgId: string;
  state: 'pending' | 'sent';
}

export interface AppData {
  v: 1;
  pair: PairState | null;
  deviceList: DeviceListJson | null;
  seenListVersion: number;
  ikTs: number;
  lastSeenPc: number | null;
  cash: CashRecord[];
}

export const emptyData = (): AppData => ({ v: 1, pair: null, deviceList: null, seenListVersion: 0, ikTs: 0, lastSeenPc: null, cash: [] });

export async function loadData(fileKey: Uint8Array): Promise<AppData> {
  if (!FILE.exists) return emptyData();
  const box = await FILE.bytes();
  const d = JSON.parse(fromUtf8(xOpen(fileKey, box, AD))) as AppData;
  return d.v === 1 ? { ...emptyData(), ...d } : emptyData();
}

let writing: Promise<void> = Promise.resolve();
/**
 * 순서대로 쓴다(겹친 저장이 섞이지 않게). 한 번 실패해도 사슬은 끊기지 않는다: 호출자는 그 실패를 받고,
 * 다음 저장은 앞 결과와 관계없이 새 상태 전체를 쓴다(상태 파일은 매번 통째로 쓰므로 마지막 성공이 최신이다).
 */
export function saveData(fileKey: Uint8Array, d: AppData): Promise<void> {
  const box = xSeal(fileKey, utf8(JSON.stringify(d)), AD);
  const mine = writing.catch(() => undefined).then(() => writeProtected(FILE, box));
  writing = mine.catch(() => undefined);
  return mine;
}
