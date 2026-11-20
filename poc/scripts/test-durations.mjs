import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.test.ts')) files.push(path.relative(root, p).split(path.sep).join('/'));
  }
};
walk(root);
const nameToFile = new Map();
for (const f of files.sort()) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/^(?:describe|test|it)\((['"`])(.*?)\1/gm)) if (!nameToFile.has(m[2])) nameToFile.set(m[2], f);
}
const dur = {};
let unmatched = 0;
for (const log of process.argv.slice(2)) {
  for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
    const m = /^\S+ [✔✖] (.*) \(([0-9.]+)ms\)\s*$/.exec(line);
    if (!m) continue;
    const f = nameToFile.get(m[1]);
    if (!f) unmatched += Number(m[2]);
    else dur[f] = (dur[f] ?? 0) + Number(m[2]) / 1000;
  }
}
const out = Object.fromEntries(Object.entries(dur).filter(([, s]) => s >= 3).sort((a, b) => b[1] - a[1]).map(([f, s]) => [f, Math.round(s)]));
fs.writeFileSync(path.join(root, 'tests', 'test-durations.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`파일 ${Object.keys(out).length}개 기록, 합 ${Object.values(out).reduce((a, b) => a + b, 0)}초, 파일을 못 찾은 시간 ${Math.round(unmatched / 1000)}초`);
