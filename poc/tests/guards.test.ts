// 정적 경계: engine의 송신 직접 import 금지(D01 §3), --remote-debugging-port 금지(D05 §3), Chrome 인자 허용 목록, 승인 창 판정.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { buildChromeArgs, chromeEnv } from '@sax/vault';
import { ApprovalGate, LAYOUT, buildApprovalHtml } from '../apps/desktop/src/approval-gate.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('정적·구성 경계', () => {
  it('eslint: engine에서 http/https/net/undici import와 fetch 사용은 오류', async () => {
    const eslint = new ESLint({ cwd: root });
    const [r] = await eslint.lintText(
      `import http from 'node:http';\nimport { connect } from 'net';\nimport { request } from 'undici';\nexport const f = () => fetch('https://x').then(() => [http, connect, request]);\n`,
      { filePath: path.join(root, 'packages/engine/src/_probe.ts') },
    );
    const ids = r!.messages.map((m) => m.ruleId);
    assert.equal(ids.filter((i) => i === 'no-restricted-imports').length, 3);
    assert.ok(ids.includes('no-restricted-globals'));
    const [ok] = await eslint.lintText(`import { Egress } from '@sax/net';\nexport const e = new Egress();\n`, { filePath: path.join(root, 'packages/engine/src/_probe.ts') });
    assert.deepEqual(ok!.messages, []);
  });

  it('eslint: --remote-debugging-port 문자열은 금지 목록 상수 밖에서 오류', async () => {
    const eslint = new ESLint({ cwd: root });
    const [r] = await eslint.lintText(`export const a = ['--remote-debugging-port=9222'];\n`, { filePath: path.join(root, 'packages/vault/src/_probe.ts') });
    assert.ok(r!.messages.some((m) => m.ruleId === 'no-restricted-syntax'));
  });

  it('Chrome 인자: 허용 목록 3개 + 금지 인자 거부, 환경 변수 화이트리스트', () => {
    assert.deepEqual(buildChromeArgs('/p'), ['--remote-debugging-pipe', '--user-data-dir=/p', '--no-first-run']);
    for (const bad of ['--remote-debugging-port=0', '--remote-allow-origins=*', '--no-sandbox', '--disable-extensions']) assert.throws(() => buildChromeArgs('/p', [bad]));
    const env = chromeEnv({ HOME: '/h', PATH: '/bin', HTTPS_PROXY: 'http://evil', CHROME_LOG_FILE: '/tmp/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  });

  it('승인 판정: 무장 지연·같은 버튼 down/up·Alt+Y만, Enter 단독 무시, 값은 이스케이프', () => {
    const g = new ApprovalGate(600);
    const c = { x: LAYOUT.approve.x + 5, y: LAYOUT.approve.y + 5 };
    g.shown(1000);
    assert.equal(g.mouse({ type: 'mouseDown', ...c, button: 'left' }, 1100), null);
    assert.equal(g.mouse({ type: 'mouseUp', ...c, button: 'left' }, 1700), null, '무장 전 down은 무효');
    assert.equal(g.key({ type: 'keyDown', key: 'Enter' }, 2000), null);
    assert.equal(g.mouse({ type: 'mouseDown', ...c, button: 'right' }, 2000), null);
    g.mouse({ type: 'mouseDown', ...c, button: 'left' }, 2000);
    assert.equal(g.mouse({ type: 'mouseUp', ...c, button: 'left' }, 2010), 'approve');
    g.shown(3000); // 다시 포커스되면 재무장
    assert.equal(g.key({ type: 'keyDown', key: 'y', alt: true }, 3100), null);
    assert.equal(g.key({ type: 'keyDown', key: 'y', alt: true }, 3700), 'approve');
    assert.equal(g.key({ type: 'keyDown', key: 'y', alt: true, control: true }, 3700), null);
    const html = buildApprovalHtml({ runId: 'r', gateStepId: 'g', actionHash: 'h'.repeat(32), titleKey: 'demo', rows: [{ labelKey: 'buyer', value: '<script>alert(1)</script>' }] });
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(html, /default-src 'none'/);
  });
});
