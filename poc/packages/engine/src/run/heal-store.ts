import type { Db } from '@sax/db';
import type { HealFile, HealStore } from '../core/heal-memory.ts';

export const healKey = (packageId: string): string => `heal.v1.${packageId}`;
export const agentPathKey = (packageId: string): string => `agentpath.v1.${packageId}`;

export interface JsonStore<T> {
  read(): T | null;
  write(v: T): void;
}

export class DbJsonStore<T> implements JsonStore<T> {
  private readonly db: Db;
  private readonly key: string;

  constructor(db: Db, key: string) {
    this.db = db;
    this.key = key;
  }

  read(): T | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(this.key) as string | undefined;
    return v ? (JSON.parse(v) as T) : null;
  }

  write(v: T): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(this.key, JSON.stringify(v));
  }
}

export class DbHealStore extends DbJsonStore<HealFile> implements HealStore {
  constructor(db: Db, packageId: string) {
    super(db, healKey(packageId));
  }
}
