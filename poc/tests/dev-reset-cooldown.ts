// PoC-3 운영 도구(ADR-022 결정 1): 홈택스 쿨다운·연속 횟수를 사람이 사유와 함께 푼다. *.test.ts가 아니라 자동 실행되지 않는다.
// 사용: node --conditions=development tests/dev-reset-cooldown.ts --root <앱 루트> --reason "<사유>"
// DB 키는 금고 키 저장소에서 읽기만 한다(없으면 만들지 않는다). 앱이 실행 중이면(쓰기 잠금을 못 잡으면) 중단한다.
// decisions.tsv 기록은 사람이 한다(이 도구는 사유를 표준 출력으로 돌려줄 뿐이다).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '@sax/db';
import { appPaths } from '@sax/platform';
import { OsKeyStore } from '@sax/vault';

const { values } = parseArgs({ options: { root: { type: 'string' }, reason: { type: 'string' } } });
const fail = (msg: string): never => {
  console.error(`dev-reset-cooldown: ${msg}`);
  process.exit(1);
};
if (!values.root) fail('--root <앱 루트>가 필요하다');
const reason = values.reason?.trim();
if (!reason) fail('--reason "<사유>"가 필요하다');

const file = path.join(appPaths(values.root).db, 'db.sqlite');
if (!fs.existsSync(file)) fail(`DB가 없다: ${file}`); // openDatabase는 없으면 만든다
// 읽기 전용 get(V12). 길이가 다르거나 없으면 만들지 않고 멈춘다(키를 새로 만들면 DB를 영영 못 연다).
const store = new OsKeyStore() as unknown as { get?: (name: string, bytes: number) => Promise<Uint8Array | null> };
if (typeof store.get !== 'function') fail('키 저장소 읽기 전용 get이 없다(금고 V12 병합 전)');
const key = await store.get!('db-key', 32);
if (!key) fail('DB 키가 없다');
const db = openDatabase(file, key!);
key!.fill(0);
try {
  db.pragma('busy_timeout = 0');
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch {
    fail('쓰기 잠금을 못 잡았다(앱이 실행 중이면 끄고 다시 한다)');
  }
  const cooldowns = db.prepare(`DELETE FROM cooldowns WHERE portal = 'hometax'`).run().changes;
  const streaks = db.prepare(`UPDATE rate_counters SET count = 0 WHERE portal = 'hometax' AND profile_id = '' AND kind IN ('block_streak', 'unknown_screen_streak') AND bucket = '-'`).run().changes;
  db.exec('COMMIT');
  console.log(JSON.stringify({ portal: 'hometax', cooldownsRemoved: cooldowns, streaksReset: streaks, reason, at: new Date().toISOString() }));
} finally {
  db.close();
}
