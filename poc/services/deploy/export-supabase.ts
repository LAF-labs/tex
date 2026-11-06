// Supabase 마이그레이션 파일을 다시 만든다: cd poc && node --conditions=development services/deploy/export-supabase.ts
// 서비스 마이그레이션(services/<서비스>/migrations)이나 한도 마이그레이션이 바뀌면 돌린다. 시험이 저장소 파일과 대조한다.
import fs from 'node:fs';
import path from 'node:path';
import { exportSupabase } from '../shared/src/index.ts';

const dir = path.join(import.meta.dirname, 'supabase', 'migrations');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.sql')) fs.rmSync(path.join(dir, f));
for (const m of exportSupabase()) fs.writeFileSync(path.join(dir, m.name), m.sql);
process.stdout.write(`supabase/migrations: ${exportSupabase().length} files\n`);
