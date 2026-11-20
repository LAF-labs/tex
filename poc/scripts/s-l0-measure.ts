import fs from 'node:fs';
import { L0_TABLE, accuracy, measureL0, qualifies } from '@sax/engine';
import { fullCorpus } from '../tests/fixtures/l0-corpus.ts';

const tallies = measureL0(fullCorpus(), { id: 'synthetic-v1', kind: 'synthetic' });
const rows = L0_TABLE.map((r) => {
  const t = tallies.find((x) => x.bundle === r.bundle && x.question === r.question);
  return {
    ...r,
    n: t?.corpus.n ?? 0,
    answered: t?.answered ?? 0,
    correct: t?.correct ?? 0,
    abstainRate: t && t.corpus.n ? +(t.abstained / t.corpus.n).toFixed(3) : null,
    accuracy: t && t.answered ? +accuracy(t).toFixed(4) : null,
    qualifiesIfReal: t ? t.answered >= 300 && accuracy(t) >= 0.995 : false,
    promoted: t ? qualifies(t) : false,
    errors: t?.errors ?? [],
  };
});
const out = new URL('../reports/raw/s-l0-synthetic.json', import.meta.url);
fs.writeFileSync(out, `${JSON.stringify({ corpus: 'synthetic-v1', generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
for (const r of rows) console.log([r.bundle, r.question, r.mode, `n=${r.n}`, `ans=${r.answered}`, `acc=${r.accuracy ?? '-'}`, `abst=${r.abstainRate ?? '-'}`, r.errors[0] ?? ''].join('\t'));
