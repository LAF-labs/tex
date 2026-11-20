import fs from 'node:fs';
import path from 'node:path';

const WIN_REALDEVICE_REPORT = path.resolve(import.meta.dirname, '../reports/WIN-REALDEVICE.md');

export function windowsRunVerified(markdown) {
  if (typeof markdown !== 'string') return false;
  const rows = markdown
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 3 && cells[1] === '설치·첫 실행');
  if (rows.length !== 1) return false;
  const result = rows[0][2];
  return result.startsWith('✅') && !/⚠️|❌|⏳/.test(result);
}

export function readWinReport(file = WIN_REALDEVICE_REPORT) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readinessBlockers(f) {
  if (f.channel !== 'beta' && f.channel !== 'stable') throw new Error(`알 수 없는 채널: ${f.channel}`);
  const blockers = [];
  if (f.signing.mode !== 'azure' && f.channel === 'stable') blockers.push({ code: 'unsigned_build', detail: f.signing.reason, missing: f.signing.missing });
  if (!f.publisherName) blockers.push({ code: 'publisher_dn_unset', detail: 'app-identity.json publisherName(서명 주체 CN, 출시 전 고정)' });
  if (f.devOnly.length) blockers.push({ code: 'dev_only_code_included', detail: 'ADR-035 W-7: 진입점이 데모·e2e·가짜 포털 코드에 닿는다', files: f.devOnly });
  if (f.outside.length) blockers.push({ code: 'runtime_reads_outside_app', detail: '설치본에 없는 저장소 경로를 런타임에 읽는다(ADR-028 결정 7 tokens.gen.ts)', files: f.outside });
  if (f.testBuild) blockers.push({ code: 'test_build', detail: '실계정 시험 빌드(--test-build): 업데이트 투명성 확인을 끌 수 있어 배포본이 아니다' });
  if (!windowsRunVerified(f.winReport)) blockers.push({ code: 'windows_run_unverified', detail: 'Windows 실기기 설치·첫 실행 통과 없음(poc/reports/WIN-REALDEVICE.md 요약 표 `설치·첫 실행` ✅)' });
  return blockers;
}

export function readiness(f) {
  const blockers = readinessBlockers(f);
  return { betaDistributable: blockers.length === 0, channel: f.channel, signed: f.signing.mode === 'azure', blockers };
}
