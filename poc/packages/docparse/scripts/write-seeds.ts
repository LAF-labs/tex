import fs from 'node:fs/promises';
import path from 'node:path';
import { seedCorpus } from '../src/fixtures/index.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: write-seeds.ts <empty dir>');
  process.exit(2);
}
await fs.mkdir(dir, { recursive: true });
if ((await fs.readdir(dir)).length) {
  console.error('dir not empty');
  process.exit(2);
}
const manifest: Array<{ name: string; target: string; bytes: number; expect: unknown }> = [];
for (const s of seedCorpus()) {
  const b = await s.bytes();
  await fs.writeFile(path.join(dir, s.name), b);
  manifest.push({ name: s.name, target: s.target, bytes: b.length, expect: s.expect });
}
await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.length} seeds → ${dir}`);
