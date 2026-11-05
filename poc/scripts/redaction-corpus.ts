// D06 §7 마스킹 코퍼스 측정표를 출력한다(reports/M1-5.md에 붙인다).
// node --conditions=development scripts/redaction-corpus.ts [건수] [시드...]
import { markdown, measure } from '../tests/fixtures/redaction-measure.ts';

const n = Number(process.argv[2] ?? 10_000);
const seeds = process.argv.slice(3).map(Number);
for (const seed of seeds.length ? seeds : [undefined]) {
  const t0 = performance.now();
  const m = measure(n, seed);
  console.log(`\n### seed ${seed ?? 'default(0x5a7e06)'} · ${m.total}건 · 누락 ${m.miss} · 출력 트립와이어 ${m.tripwireAfter} · 정상 문구 과치환 ${m.benign.changed.length}/${m.benign.n} · ${Math.round(performance.now() - t0)} ms\n`);
  console.log(markdown(m));
  for (const x of m.misses.slice(0, 10)) console.log(`- 누락 #${x.id} ${x.kind}/${x.variant}: ${JSON.stringify(x.out).slice(0, 200)}`);
}
