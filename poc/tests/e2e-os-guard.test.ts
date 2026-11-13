// 시험이 대표 화면에 실제 Finder·브라우저·대화상자를 띄우지 않는다(대표 보고 2026-11-13).
// 모든 Electron e2e 입구는 os-guard를 맨 먼저 불러오고, Finder를 앞으로 올리는 headful 검사는 플래그 아래에서 창을 만들지 않는 activate만 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const dir = new URL('../apps/desktop/e2e/', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'os-guard.ts' && !f.startsWith('fake-account'));

describe('e2e는 실제 OS 창을 띄우지 않는다', () => {
  it('os-guard가 Finder·브라우저·대화상자 일곱 개를 대역으로 바꾼다', () => {
    const g = read('os-guard.ts');
    for (const fn of ['shell.openPath', 'shell.showItemInFolder', 'shell.openExternal', 'dialog.showOpenDialog', 'dialog.showSaveDialog', 'dialog.showMessageBox', 'dialog.showErrorBox']) assert.match(g, new RegExp(`^${fn.replace('.', '\\.')} = `, 'm'), fn);
  });
  it('electron을 쓰는 e2e 입구는 모두 os-guard를 첫 import로 둔다', () => {
    assert.ok(entries.length >= 13, entries.join(','));
    for (const f of entries) {
      const s = read(f);
      if (!/from 'electron'/.test(s)) continue;
      const first = s.split('\n').find((l) => l.startsWith('import '));
      assert.equal(first, "import './os-guard.js'; // 실제 Finder·브라우저·대화상자를 띄우지 않는다(맨 먼저)", f);
    }
  });
  it('Finder를 앞으로 올리는 검사는 플래그 아래에서만, 창을 만드는 open -a는 쓰지 않는다', () => {
    for (const [f, flag] of [
      [path.join(dir.pathname, 'shell-handoff-e2e.ts'), 'SAX_E2E_HEADFUL'],
      [new URL('vault-browser-focus.test.ts', import.meta.url).pathname, 'SAX_FOCUS_HEADFUL'],
    ] as const) {
      const s = fs.readFileSync(f, 'utf8');
      assert.ok(!/execFileSync\('open', \['-a'/.test(s), f);
      assert.match(s, new RegExp(`const headful = process\\.env\\.${flag} === '1' && process\\.platform === 'darwin';`), f);
      assert.match(s, /if \(headful\) \{\s*(\/\/[^\n]*\n\s*)*for \(let i = 0; i < 5 && !\/Finder\/\.test\(frontApp\(\)\); i\+\+\) \{\s*execFileSync\('osascript', \['-e', 'tell application "Finder" to activate'\]\);/, f);
    }
  });
});
