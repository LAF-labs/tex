// 앱 상태 파일(페어링 기록·기기 목록·IK 타임스탬프·현금매출 기록). fileKey로 XChaCha20-Poly1305 봉인해 sax/state.bin에 둔다.
import { File } from 'expo-file-system';
import { fromUtf8, utf8, xOpen, xSeal, type DeviceListJson } from '@sax/remote';
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
  cert: string;
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
/** 순서대로 쓴다(겹친 저장이 섞이지 않게). */
export function saveData(fileKey: Uint8Array, d: AppData): Promise<void> {
  const box = xSeal(fileKey, utf8(JSON.stringify(d)), AD);
  writing = writing.then(() => writeProtected(FILE, box));
  return writing;
}
