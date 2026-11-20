import fs from 'node:fs';
import path from 'node:path';
import { exportSupabase } from '../shared/src/index.ts';

const dir = path.join(import.meta.dirname, 'supabase', 'migrations');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.sql')) fs.rmSync(path.join(dir, f));
for (const m of exportSupabase()) fs.writeFileSync(path.join(dir, m.name), m.sql);
process.stdout.write(`supabase/migrations: ${exportSupabase().length} files\n`);
