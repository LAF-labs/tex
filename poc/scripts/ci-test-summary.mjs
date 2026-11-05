// CI 실패 시 시험 요약(마크다운). node --test spec 출력 로그(*.log)에서 실패 줄과 ℹ 합계를 뽑는다.
// 사용: node scripts/ci-test-summary.mjs <로그 폴더>   → stdout(GITHUB_STEP_SUMMARY로 보낸다). summary.md도 그 폴더에 남긴다.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort() : [];
// ANSI 색 코드 제거
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const out = ['## 시험 요약', ''];
if (!logs.length) out.push(`로그 없음(${dir}). 시험 전 단계(설치·빌드·린트)에서 실패했다.`);
for (const f of logs) {
  const lines = strip(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n');
  const totals = lines.filter((l) => /^ℹ (tests|pass|fail|cancelled|skipped|todo) /.test(l)).map((l) => l.slice(2).trim());
  // 실패한 it/describe 이름. 들여쓰기로 단계가 보이므로 그대로 둔다. 같은 이름이 끝의 failing tests 목록에 다시 나오니 중복 제거.
  const failed = [...new Set(lines.filter((l) => /^\s*✖ /.test(l)).map((l) => l.replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '')))];
  out.push(`### ${f}`, '', totals.length ? totals.map((t) => `- ${t}`).join('\n') : '- 합계 줄 없음(실행이 중간에 끊겼을 수 있다)', '');
  if (failed.length) {
    out.push('<details><summary>실패 ' + failed.length + '줄</summary>', '', '```', ...failed.slice(0, 200), '```', '', '</details>', '');
  }
}
const md = out.join('\n');
if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'summary.md'), md);
process.stdout.write(md + '\n');
