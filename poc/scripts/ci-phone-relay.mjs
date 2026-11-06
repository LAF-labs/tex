// CI: 폰 릴레이 경로 스모크(D14 M5-1·M7-2·M7-4). apps/mobile의 더미 PC + 개발 릴레이를 띄우고 Node 폰으로
// 페어링 → 기기 토큰(AIK 인증서 + DPoP) → 우편함 라이브 → IK 세션 → 사진·현금매출 전송을 본다.
// 라이브(WSS)와 HTTPS 큐(--queue) 두 경로를 각각 새 더미 PC에 돌린다(더미 PC의 수신 수는 누적이라 경로마다 새로 띄운다).
// 실서버·실계정 없음: 모두 localhost. 받은 파일은 apps/mobile/dev/out/(git 제외).
// 사용: node scripts/ci-phone-relay.mjs   (apps/mobile 의존성이 설치돼 있어야 한다: pnpm --dir apps/mobile install --frozen-lockfile)
import { spawn } from 'node:child_process';
import path from 'node:path';

const mobile = path.resolve(import.meta.dirname, '..', 'apps', 'mobile');
const PORT = 8787;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(pc, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pc.exitCode !== null) throw new Error(`더미 PC가 먼저 끝남(코드 ${pc.exitCode})`);
    try {
      const r = await fetch(`http://localhost:${PORT}/dev/status`);
      if (r.ok) return;
    } catch {
      // 아직 안 떴다
    }
    await sleep(200);
  }
  throw new Error('더미 PC가 뜨지 않음');
}

function run(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: mobile, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('exit', (code, sig) => {
      clearTimeout(t);
      resolve(code ?? (sig ? 124 : 1));
    });
  });
}

let failed = 0;
for (const mode of [[], ['--queue']]) {
  const label = mode.length ? 'HTTPS 큐' : '라이브';
  const pc = spawn(process.execPath, ['dev/dummy-pc.ts'], { cwd: mobile, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: String(PORT) } });
  try {
    await waitUp(pc);
    const code = await run(['dev/smoke-phone.ts', ...mode]);
    console.log(`${code === 0 ? '✔' : '✖'} 폰 릴레이 스모크(${label}) 코드 ${code}`);
    if (code !== 0) failed++;
  } catch (e) {
    console.log(`✖ 폰 릴레이 스모크(${label}): ${e.message}`);
    failed++;
  } finally {
    pc.kill('SIGTERM');
    await new Promise((r) => (pc.exitCode !== null ? r() : pc.once('exit', r)));
  }
}
process.exit(failed ? 1 : 0);
