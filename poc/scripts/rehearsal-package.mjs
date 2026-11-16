#!/usr/bin/env node
// 예행 전용 로컬 패키지 넣기(부장 2026-11-13): 레포의 패키지 원본을 앱 데이터의 rehearsal-packages/<id>/로 복사한다.
// 앱은 도구 > 홈택스 예행(발급 안 함) 실행에서만 이 폴더를 본다(엔진 RunService). 게시 서명은 필요 없고, 엔진 로더 검사와
// "서명 설치본보다 약하지 않음" 검사를 지나야 쓴다. 판정 결과는 engine.log run.rehearsal_report의 package(local:<판>:<다이제스트>)로 확인한다.
//
//   node scripts/rehearsal-package.mjs                 # packages/engine/playbooks/hometax.invoice.issue → 기본 앱 데이터
//   node scripts/rehearsal-package.mjs --from <폴더>   # 다른 원본 폴더(manifest.json·playbook.json·selectors.json·strings.ko.json)
//   node scripts/rehearsal-package.mjs --app <폴더>    # 다른 앱 데이터 폴더(격리 프로필 등)
//   node scripts/rehearsal-package.mjs --remove        # 로컬 패키지를 지운다(예행이 다시 레지스트리 판을 쓴다)
//   node scripts/rehearsal-package.mjs --id hometax.cert.biz_registration   # 다른 패키지(민원증명 4종·hometax.cert.issued_list)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['manifest.json', 'playbook.json', 'selectors.json', 'strings.ko.json'];
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const defaultApp = () => {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? '', 'SovereignAX');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SovereignAX');
  return path.join(os.homedir(), '.local', 'share', 'SovereignAX');
};
const ID = opt('--id') ?? 'hometax.invoice.issue';
if (!/^[a-z0-9_.]{1,80}$/.test(ID)) throw new Error(`id 모양이 틀림: ${ID}`);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.resolve(opt('--from') ?? path.join(repo, 'packages', 'engine', 'playbooks', ID));
const to = path.join(path.resolve(opt('--app') ?? defaultApp()), 'rehearsal-packages', ID);

if (args.includes('--remove')) {
  fs.rmSync(to, { recursive: true, force: true });
  console.log(`removed ${to}`);
  process.exit(0);
}
for (const f of FILES) if (!fs.existsSync(path.join(from, f))) throw new Error(`없음: ${path.join(from, f)}`);
fs.mkdirSync(to, { recursive: true, mode: 0o700 });
for (const f of FILES) {
  JSON.parse(fs.readFileSync(path.join(from, f), 'utf8'));
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
const m = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8'));
console.log(`copied ${m.id} ${m.version} → ${to}`);
