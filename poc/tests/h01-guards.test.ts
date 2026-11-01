// PoC-6 정적 경계(ADR-021): 승인 근거는 승인 바 → main → 게이트 포트로만 간다. 렌더러 IPC 처리기·중계 통로에는 승인 경로가 없다.
// 소스를 읽어 확인한다(실행 경로는 shell-e2e가 렌더러 메서드를 모두 불러 확인한다).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GATE_ONLY_METHODS, READ_QUERIES, COMMANDS, RUN_COMMANDS } from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;
/** start부터 end 앞까지(둘 다 처음 나온 곳). */
const between = (s: string, start: string, end: string) => {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `${start} … ${end}`);
  return s.slice(i, j);
};

describe('H-01 승인 경계(ADR-021)', () => {
  it('shell-app: answerGate는 승인 바 결과 처리에서 한 번만, 렌더러 처리기 표에는 승인·게이트 경로가 없다', () => {
    const src = read('apps/desktop/src/shell-app.ts');
    assert.equal(count(src, 'answerGate('), 1);
    const onGate = between(src, "runs.on('gate',", 'const g24Doc');
    assert.ok(onGate.includes('bar.open(req)') && onGate.includes("o.decision === 'approve'") && onGate.includes('host.answerGate(o.approval)'));
    const handlers = between(src, 'const handlers:', "ipcMain.handle('sax'");
    for (const bad of ['answerGate', 'issueLocalApproval', 'verifyLocalApproval', 'approved(', 'abortGate', 'bar.', 'host.rpc', 'host.control', 'gate.answer']) assert.ok(!handlers.includes(bad), `렌더러 처리기에 ${bad}`);
    // 렌더러 IPC는 메인 창 셸 페이지에서 온 것만.
    assert.match(src, /e\.sender !== wc \|\| e\.senderFrame\?\.url !== SHELL_URL/);
  });

  it('shell-runs·main.ts(개발 콘솔)·렌더러 정적 파일에는 게이트 답 경로가 없다', () => {
    for (const p of ['apps/desktop/src/shell-runs.ts', 'apps/desktop/src/main.ts', 'apps/desktop/static/preload-shell.cjs', 'apps/desktop/static/shell/shell.js', 'apps/desktop/static/shell/shell-views.js']) {
      const src = read(p);
      for (const bad of ['answerGate', 'gate.answer', 'gatePort']) assert.ok(!src.includes(bad), `${p}: ${bad}`);
    }
    const preload = read('apps/desktop/static/preload-shell.cjs');
    assert.equal(count(preload, 'ipcRenderer.invoke('), 1, 'preload는 sax 호출 채널 하나');
  });

  it('engine-host: 게이트 포트로 보내는 곳은 answerGate 하나, 엔진 entry: 승인은 게이트 포트 처리기에서만 받는다', () => {
    const host = read('apps/desktop/src/engine-host.ts');
    assert.equal(count(host, 'gatePort.postMessage('), 1);
    assert.ok(between(host, 'answerGate(approval: LocalApproval)', 'secretInputPort()').includes('gatePort.postMessage('));
    const entry = read('packages/engine/src/entry.ts');
    assert.equal(count(entry, '.answer('), 1);
    assert.ok(between(entry, 'gate.onMessage(', 'runs.on(').includes('runs!.answer(g.approval)'));
    // 중계 통로 허용 목록에 승인·증언 이름이 없다.
    const relay = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS]);
    for (const m of GATE_ONLY_METHODS) assert.ok(!relay.has(m), m);
  });
});
