// M6-12 퍼징 시드 코퍼스를 파일로 쓴다(보안 스위트·외부 퍼저 입력). 저장소 밖 빈 폴더를 준다(측정·시드 산출물은 커밋하지 않는다).
// 실행: node --conditions=development packages/docparse/scripts/write-seeds.ts <빈 폴더>
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
