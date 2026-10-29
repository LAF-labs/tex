// 번들 다이제스트·앱 내장 허용 목록·임계값 프로필 다이제스트를 다시 쓴다(BV-06).
// node --conditions=development scripts/bundles-digest.ts [--check]
// --check: 쓰지 않고 차이만 확인(CI). 다이제스트가 바뀐 번들에 재산정 프로필(overrides)이 있으면 실패한다.
import fs from 'node:fs';
import { assemblePrefix, computeDigest, readBundleDefs, wireIdOf, type ThresholdProfile } from '@sax/model';

const root = new URL('../packages/model/', import.meta.url);
const check = process.argv.includes('--check');
const diffs: string[] = [];
const allow: Array<{ id: string; digest: string }> = [];

for (const def of readBundleDefs(new URL('bundles/', root))) {
  const digest = computeDigest(def, assemblePrefix(def, new URL('bundles/prefixes/', root)));
  allow.push({ id: wireIdOf(def), digest });
  if (def.digest !== digest) {
    diffs.push(`${wireIdOf(def)} digest`);
    if (!check) fs.writeFileSync(new URL(`bundles/${wireIdOf(def)}.json`, root), `${JSON.stringify({ ...def, digest }, null, 2)}\n`);
  }
}

const allowSrc = `// 생성 파일: node scripts/bundles-digest.ts 가 쓴다. 손으로 고치지 않는다(BV-06, 앱 업데이트로만 바뀜).
export const BUNDLE_ALLOWLIST: ReadonlyArray<{ id: string; digest: string }> = [
${allow.map((a) => `  { id: '${a.id}', digest: '${a.digest}' },`).join('\n')}
];
`;
const allowFile = new URL('src/bundle/allowlist.ts', root);
if (fs.readFileSync(allowFile, 'utf8') !== allowSrc) {
  diffs.push('allowlist.ts');
  if (!check) fs.writeFileSync(allowFile, allowSrc);
}

// 프로필: OpenAI gpt-6-luna = 설계 초기값(initial). Upstage solar-decide = 재산정 전이라 사용 불가(uncalibrated, ADR-015).
const profFile = new URL('profiles/thresholds.json', root);
const prev = JSON.parse(fs.readFileSync(profFile, 'utf8')) as ThresholdProfile[];
const next: ThresholdProfile[] = [];
for (const a of allow) {
  for (const [provider, model, status] of [['openai', 'gpt-6-luna', 'initial'], ['upstage', 'solar-decide', 'uncalibrated']] as const) {
    const old = prev.find((p) => p.bundle === a.id && p.provider === provider && p.model === model);
    if (old && old.bundleDigest !== a.digest && old.overrides.length) {
      console.error(`${a.id}/${provider}: 다이제스트가 바뀌었는데 재산정 프로필이 있다. 같은 코퍼스로 다시 산정해야 한다.`);
      process.exit(1);
    }
    next.push({ bundle: a.id, bundleDigest: a.digest, provider, model, status: old?.status ?? status, ...(old?.corpus ? { corpus: old.corpus } : {}), overrides: old?.overrides ?? [] });
  }
}
const profSrc = `${JSON.stringify(next, null, 2)}\n`;
if (fs.readFileSync(profFile, 'utf8') !== profSrc) {
  diffs.push('profiles/thresholds.json');
  if (!check) fs.writeFileSync(profFile, profSrc);
}

if (check && diffs.length) {
  console.error(`out of date: ${diffs.join(', ')}`);
  process.exit(1);
}
console.log(diffs.length ? `updated: ${diffs.join(', ')}` : 'up to date');
