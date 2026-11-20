import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort() : [];
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s) => s.replace(ANSI, '');
const out = ['## 시험 요약', ''];
if (!logs.length) out.push(`로그 없음(${dir}). 시험 전 단계(설치·빌드·린트)에서 실패했다.`);
for (const f of logs) {
  const lines = strip(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n');
  const totals = lines.filter((l) => /^ℹ (tests|pass|fail|cancelled|skipped|todo) /.test(l)).map((l) => l.slice(2).trim());
  const failed = [...new Set(lines.filter((l) => /^\s*✖ /.test(l)).map((l) => l.replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '')))];
  out.push(`### ${f}`, '', totals.length ? totals.map((t) => `- ${t}`).join('\n') : '- 합계 줄 없음(실행이 중간에 끊겼을 수 있다)', '');
  if (failed.length) {
    out.push('<details><summary>실패 ' + failed.length + '줄</summary>', '', '```', ...failed.slice(0, 200), '```', '', '</details>', '');
  }
}
const md = out.join('\n');
if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'summary.md'), md);
process.stdout.write(md + '\n');
