import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GATE_ONLY_METHODS, READ_QUERIES, COMMANDS, RUN_COMMANDS } from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;
const between = (s: string, start: string, end: string) => {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `${start} … ${end}`);
  return s.slice(i, j);
};

describe('H-01 승인 경계(ADR-021)', () => {
  it('engine entry accepts only init', () => {
    const entry = read('packages/engine/src/entry.ts');
    const lines = entry.split('\n').filter((l) => l.includes("'vault-port'"));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0]!, /return parentPort\.postMessage\(\{ t: 'fatal', code: 'engine\.vault_port_unsupported' \}\)/);
    assert.ok(entry.includes("msg?.t === 'init' && e.ports[0]"));
    assert.ok(!entry.includes("portal: { kind: 'hometax' } }"), '옛 기동용 기본 초기화가 없다');
    assert.match(entry.split('\n').find((l) => l.startsWith('import '))!, /from '\.\/env-guard\.ts'/);
    assert.ok(entry.includes("vault.on('secret_window.leak_suspected', () => runs?.leakSuspected())"));
  });

  it('shell-app: answerGate는 승인 바 결과 처리에서 한 번만, 렌더러 처리기 표에는 승인·게이트 경로가 없다', () => {
    const src = read('apps/desktop/src/shell-app.ts');
    assert.equal(count(src, 'answerGate('), 1);
    const onGate = between(src, "runs.on('gate',", 'const g24Doc');
    assert.ok(onGate.includes('bar.open(req, gr?.auth, offer, runs.get(runId)?.cert?.name)') && onGate.includes("o.decision === 'approve'") && onGate.includes('host.answerGate(approval)') && onGate.includes('await sendApproval(o.approval)'));
    assert.equal(count(onGate, 'issueLocalApproval('), 2);
    assert.ok(between(onGate, '?.offer(runId, req, {', 'deny: async').includes("await sendApproval(issueLocalApproval(key, req, 'remote+px'), REMOTE_APPROVED_NOTE);"));
    assert.equal(count(src, "'remote+px'"), 1);
    assert.ok(onGate.includes('if (offer && o.batch === offer.count && !runs.batchApproved(runId, offer)) send({ type: \'say\', text: BATCH_CHANGED_NOTE });'));
    assert.ok(onGate.includes("if (runs.batchAutoApprove(runId, req)) return void sendApproval(issueLocalApproval(key, req, 'click+batch'), BATCH_AUTO_NOTE);"));
    const handlers = between(src, 'const handlers:', "ipcMain.handle('sax'");
    for (const bad of ['answerGate', 'issueLocalApproval', 'verifyLocalApproval', 'approved(', 'abortGate', 'bar.', 'host.rpc', 'host.control', 'gate.answer', 'answerAttest', 'issueLocalAttestation', 'verifyLocalAttestation', 'attestUsed', 'showAttest', 'attest.answer']) assert.ok(!handlers.includes(bad), `렌더러 처리기에 ${bad}`);
    assert.equal(count(src, 'answerAttest('), 1);
    const onAttest = between(src, 'const showAttest =', "runs.on('attest-ready'");
    assert.ok(onAttest.includes('bar.openAttest(req)') && onAttest.includes("o.decision !== 'attest'") && onAttest.includes('host.answerAttest(o.attestation)'));
    assert.match(src, /e\.sender !== wc \|\| e\.senderFrame\?\.url !== SHELL_URL/);
  });

  it('shell-runs·렌더러 정적 파일에는 게이트 답 경로가 없다', () => {
    for (const p of ['apps/desktop/src/shell-runs.ts', 'apps/desktop/static/preload-shell.cjs', 'apps/desktop/static/shell/shell.js', 'apps/desktop/static/shell/shell-views.js']) {
      const src = read(p);
      for (const bad of ['answerGate', 'gate.answer', 'gatePort', 'answerAttest', 'attest.answer']) assert.ok(!src.includes(bad), `${p}: ${bad}`);
    }
    const preload = read('apps/desktop/static/preload-shell.cjs');
    assert.equal(count(preload, 'ipcRenderer.invoke('), 1, 'preload는 sax 호출 채널 하나');
  });

  it('engine-host: 게이트 포트로 보내는 곳은 answerGate 하나, 엔진 entry: 승인은 게이트 포트 처리기에서만 받는다', () => {
    const host = read('apps/desktop/src/engine-host.ts');
    assert.equal(count(host, 'gatePort.postMessage('), 2);
    assert.ok(between(host, 'answerGate(approval: LocalApproval)', 'answerAttest(').includes('gatePort.postMessage('));
    assert.ok(between(host, 'answerAttest(attestation: LocalAttestation', 'secretInputPort(bind: SecretInputBind)').includes("gatePort.postMessage({ t: 'attest.answer'"));
    const entry = read('packages/engine/src/entry.ts');
    assert.equal(count(entry, '.answer('), 1);
    assert.ok(between(entry, 'gate.onMessage(', 'runs.on(').includes('runs!.answer(g.approval)'));
    const relay = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS]);
    for (const m of GATE_ONLY_METHODS) assert.ok(!relay.has(m), m);
  });
});
