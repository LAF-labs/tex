// M4-1 IPC 라우터(D01 §2.1, D11 §4 IPC 행): 채널 이름, 렌더러 요청 표 검사, 최상위 프레임 확인. Electron 없이 돈다.
// 실행 경로(실제 창에서 표에 없는 필드·열거값 거부)는 shell-e2e가 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkParams, dispatchShell, IPC, isTopFrame, parseRendererRequest, SHELL_METHODS, USER_ACTION_METHODS, type ShellHandlers } from '../apps/desktop/src/ipc.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const URL_ = 'sax-shell://shell/shell.html';
const top = { url: URL_, parent: null };
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('IPC 채널 이름(한곳에 정의, preload는 글자 그대로)', () => {
  it('preload·창 코드가 쓰는 채널이 IPC 상수와 같다', () => {
    const shellPreload = read('apps/desktop/static/preload-shell.cjs');
    assert.ok(shellPreload.includes(`ipcRenderer.invoke('${IPC.call}'`) && shellPreload.includes(`ipcRenderer.on('${IPC.event}'`));
    assert.ok(read('apps/desktop/static/preload-app.cjs').includes(`ipcRenderer.invoke('${IPC.call}'`));
    assert.ok(read('apps/desktop/static/preload-secret.cjs').includes(`ipcRenderer.once('${IPC.secretPort}'`));
    assert.ok(read('apps/desktop/static/preload-docparse.cjs').includes(`ipcRenderer.once('${IPC.docparsePort}'`));
    assert.ok(read('apps/desktop/src/docparse.ts').includes(`postMessage('${IPC.docparsePort}'`));
    assert.ok(read('apps/desktop/src/secret-window.ts').includes('postMessage(IPC.secretPort'));
    const shell = read('apps/desktop/src/shell-app.ts');
    assert.ok(shell.includes(`ipcMain.handle('${IPC.call}'`) && shell.includes('wc.send(IPC.event, ev)'));
  });

  it('preload는 좁은 함수만 노출한다(raw ipcRenderer 금지)', () => {
    for (const p of ['apps/desktop/static/preload-shell.cjs', 'apps/desktop/static/preload-app.cjs']) {
      const src = read(p);
      assert.equal(src.split('exposeInMainWorld(').length - 1, 1, p);
      assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(src), `${p}: ipcRenderer 그대로 노출`);
      assert.ok(!src.includes('ipcRenderer.send(') && !src.includes('sendSync'), p);
    }
    // 포트 넘김 preload는 아무것도 노출하지 않는다.
    for (const p of ['apps/desktop/static/preload-secret.cjs', 'apps/desktop/static/preload-docparse.cjs']) assert.ok(!read(p).includes('contextBridge'), p);
  });
});

describe('렌더러 요청 표(SHELL_METHODS)', () => {
  it('메서드가 표에 없으면 모양보다 먼저 unknown_method, 프로토타입 이름도 없는 메서드다', () => {
    for (const m of ['bar.hide', 'run.approve', 'gate.answer', 'answerGate', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.equal(code(() => parseRendererRequest(SHELL_METHODS, { method: m, params: 5 })), 'unknown_method', m);
    }
  });

  it('요청 모양: 객체·문자열 메서드·평범한 객체 인자만', () => {
    for (const req of [null, 'docs.list', [], { method: 1 }, { method: 'docs.list', params: [] }, { method: 'docs.list', params: 'x' }, { method: 'docs.list', params: new Date() }]) {
      assert.equal(code(() => parseRendererRequest(SHELL_METHODS, req)), 'bad_request', JSON.stringify(req));
    }
    assert.deepEqual(parseRendererRequest(SHELL_METHODS, { method: 'docs.list' }), { method: 'docs.list', params: {} });
  });

  it('표에 없는 필드·필수 필드 없음·틀린 형·넘친 길이·틀린 열거값은 bad_request', () => {
    const bad: Array<[string, unknown]> = [
      ['docs.list', { x: 1 }],
      ['run.prepare', {}],
      ['run.prepare', { id: 1 }],
      ['run.prepare', { id: 'r'.repeat(129) }],
      ['run.stop', { id: 'r1', approve: true }],
      ['profile.set', { kind: 'admin' }],
      ['profile.set', { kind: null }],
      ['request.send', { text: 'x'.repeat(10_001) }],
      ['draft.update', { id: 'r1', amount: Number.NaN }],
      ['draft.update', { id: 'r1', amount: '1' }],
      ['docs.import', { pick: 'yes' }],
      ['docs.update', { id: 'd1', patch: { docType: 'x', path: '/etc/passwd' } }],
      ['docs.update', { id: 'd1', patch: [] }],
      ['g24.save', { id: 'c1', doc: '가족관계증명서' }],
      ['g24.candidates', { doc: '주민등록표 등본' }],
      ['docs.importCancel', {}],
      ['docs.importCancel', { pickId: 1 }],
      ['docs.importCancel', { pickId: 'p'.repeat(129) }],
    ];
    for (const [method, params] of bad) assert.equal(code(() => parseRendererRequest(SHELL_METHODS, { method, params })), 'bad_request', `${method} ${JSON.stringify(params)}`);
  });

  it('지금 렌더러가 보내는 모양은 통과한다(null 허용 칸, 없는 칸은 undefined로 본다)', () => {
    const good: Array<[string, Record<string, unknown>]> = [
      ['request.send', { text: '세금계산서', vat: null }],
      ['request.send', { text: '세금계산서', vat: 'included' }],
      ['draft.update', { id: 'r1', amountText: '1억 2천만원' }],
      ['docs.import', { pick: true }],
      ['docs.import', { pickId: 'p1', password: 'pw' }],
      ['docs.importCancel', { pickId: 'p1' }],
      ['docs.update', { id: 'd1', patch: { expiresOn: null }, seen: { docType: 'other', issuedOn: null, expiresOn: null } }],
      ['docs.update', { id: 'd1', patch: {}, seen: undefined }],
      ['g24.candidates', { doc: '주민등록표 초본', startedAt: 0 }],
      ['clipboard.copy', { text: '123-45-67890' }],
    ];
    for (const [method, params] of good) assert.ok(checkParams(SHELL_METHODS[method as keyof typeof SHELL_METHODS], params), `${method} ${JSON.stringify(params)}`);
  });

  it('렌더러 정적 파일이 부르는 메서드는 모두 표에 있다', () => {
    const src = ['shell.js', 'shell-views.js', 'shell-g24.js'].map((f) => read(`apps/desktop/static/shell/${f}`)).join('\n');
    const called = new Set([...src.matchAll(/call\('([a-zA-Z0-9.]+)'/g)].map((m) => m[1]!));
    assert.ok(called.size >= 10, `${called.size}`);
    for (const m of called) assert.ok(Object.hasOwn(SHELL_METHODS, m), m);
  });

  it('표에는 승인·게이트·바 경로가 없다(ADR-021)', () => {
    for (const m of Object.keys(SHELL_METHODS)) assert.ok(!/approv|gate|bar\.|answer|attest|secret|vault\./i.test(m), m);
  });

  it('사용자 동작 명령은 처리기가 그 시간으로 needGesture를 부른다(ADR-027 결정 8)', () => {
    const src = read('apps/desktop/src/shell-app.ts');
    const table = src.slice(src.indexOf('const handlers:'), src.indexOf("ipcMain.handle('sax'"));
    for (const [m, ms] of Object.entries(USER_ACTION_METHODS)) {
      const start = table.indexOf(`'${m}':`);
      assert.ok(start >= 0, m);
      const next = table.slice(start + 3).search(/\n {4}'[a-z0-9.]+': /);
      const body = table.slice(start, next < 0 ? undefined : start + 3 + next);
      assert.ok(body.includes(`needGesture(${ms.toLocaleString('en-US').replace(',', '_')})`), `${m}: needGesture(${ms})`);
    }
  });
});

describe('최상위 프레임·처리기 연결', () => {
  it('isTopFrame: 같은 주소의 최상위 프레임만', () => {
    assert.equal(isTopFrame(top, URL_), true);
    assert.equal(isTopFrame({ url: URL_, parent: {} as never }, URL_), false, 'iframe 안 같은 페이지');
    assert.equal(isTopFrame({ url: 'sax-shell://shell/secret.html', parent: null }, URL_), false);
    assert.equal(isTopFrame(null, URL_), false);
    assert.equal(isTopFrame(undefined, URL_), false);
  });

  it('dispatchShell: 하위 프레임은 forbidden, 표를 지난 인자만 처리기에 간다', async () => {
    const seen: unknown[] = [];
    const handlers = Object.fromEntries(Object.keys(SHELL_METHODS).map((m) => [m, (p: unknown) => (seen.push([m, p]), m)])) as unknown as ShellHandlers;
    await assert.rejects(dispatchShell({ url: URL_, parent: {} as never }, URL_, handlers, { method: 'docs.list' }), /forbidden/);
    await assert.rejects(dispatchShell(top, URL_, handlers, { method: 'run.stop', params: { id: 'r', x: 1 } }), /bad_request/);
    assert.equal(await dispatchShell(top, URL_, handlers, { method: 'run.stop', params: { id: 'r' } }), 'run.stop');
    assert.deepEqual(seen, [['run.stop', { id: 'r' }]]);
  });
});
