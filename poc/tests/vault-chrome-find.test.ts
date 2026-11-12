// 전용 Chrome 찾기(고객 PoC, sovereign-ax/install-guide/CUSTOMER-DIST.md §1.2): 내장 후보만, Mac은 ~/Applications도,
// 없으면 금고는 고정 코드 chrome.not_installed를 던지고 엔진은 그 코드로 실행을 끝낸다(engine.error가 아니다, 데스크톱 사람 말 표의 키).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CHROME_NOT_INSTALLED_CODE, connectRunBrowser, RunEnd, type VaultClient } from '@sax/engine';
import { CHROME_CANDIDATES, CHROME_NOT_INSTALLED, findInstalledChrome } from '@sax/vault';

const SYSTEM_MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('전용 Chrome 찾기', () => {
  it('Mac 후보: /Applications 먼저, 그다음 이 사용자의 ~/Applications. 다른 Chromium은 없다', () => {
    assert.deepEqual(CHROME_CANDIDATES.darwin, [SYSTEM_MAC_CHROME, '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
    for (const list of Object.values(CHROME_CANDIDATES)) for (const c of list ?? []) assert.match(c, /Google[\\/ ]Chrome|google-chrome|google\/chrome/i, c);
  });

  it('~/Applications의 Chrome을 찾는다(홈은 os.homedir 자리), 홈을 모르면 그 후보는 건너뛴다', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sax-chrome-home-')));
    try {
      const exe = path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '');
      // 이 기기의 /Applications에 Chrome이 있으면 그쪽이 먼저다
      const system = fs.existsSync(SYSTEM_MAC_CHROME) ? SYSTEM_MAC_CHROME : null;
      assert.equal(findInstalledChrome('darwin', home), system ?? exe);
      assert.equal(findInstalledChrome('darwin', ''), system);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('금고와 엔진의 코드가 같다', () => {
    assert.equal(CHROME_NOT_INSTALLED, 'chrome.not_installed');
    assert.equal(CHROME_NOT_INSTALLED_CODE, CHROME_NOT_INSTALLED);
    const svc = fs.readFileSync(new URL('../packages/vault/src/service.ts', import.meta.url), 'utf8');
    assert.match(svc, /if \(!exe\) throw new Error\(CHROME_NOT_INSTALLED\);/);
    assert.doesNotMatch(svc, /chrome not installed/);
  });

  it('엔진: 금고가 chrome.not_installed로 거절하면 RunEnd(failed, chrome.not_installed), 다른 오류는 그대로', async () => {
    const fake = (err: string) => ({ rpc: async () => Promise.reject(new Error(`vault: ${err}`)) }) as unknown as VaultClient;
    await assert.rejects(connectRunBrowser(fake(CHROME_NOT_INSTALLED)), (e: unknown) => e instanceof RunEnd && e.status === 'failed' && e.code === 'chrome.not_installed');
    await assert.rejects(connectRunBrowser(fake('already launched')), (e: unknown) => !(e instanceof RunEnd) && (e as Error).message === 'vault: already launched');
  });
});
