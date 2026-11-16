// 고친 선택자 기억(core/heal-memory.ts)의 PC 저장소: 암호화 DB settings 한 칸(마이그레이션 없음) `heal.v1.<패키지 id>`.
import type { Db } from '@sax/db';
import type { HealFile, HealStore } from '../core/heal-memory.ts';

export const healKey = (packageId: string): string => `heal.v1.${packageId}`;

export class DbHealStore implements HealStore {
  private readonly db: Db;
  private readonly key: string;

  constructor(db: Db, packageId: string) {
    this.db = db;
    this.key = healKey(packageId);
  }

  read(): HealFile | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(this.key) as string | undefined;
    return v ? (JSON.parse(v) as HealFile) : null;
  }

  write(f: HealFile): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(this.key, JSON.stringify(f));
  }
}
