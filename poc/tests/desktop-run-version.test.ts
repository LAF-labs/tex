import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runVersion } from '../apps/desktop/src/run-version.ts';

describe('앱 판(레지스트리 minAppVersion·폰 hello)', () => {
  it('패키지된 앱은 SAX_DEV_APP_VERSION을 무시하고, 개발 빌드는 x.y.z 형식만 받는다', () => {
    const real = () => '0.0.0';
    assert.equal(runVersion(true, { SAX_DEV_APP_VERSION: '9.9.9' }, () => '0.1.35'), '0.1.35');
    assert.equal(runVersion(false, { SAX_DEV_APP_VERSION: '0.1.35' }, real), '0.1.35');
    assert.equal(runVersion(false, {}, real), '0.0.0');
    for (const bad of ['0.1', '0.1.35-beta', ' 0.1.35', 'v0.1.35']) assert.equal(runVersion(false, { SAX_DEV_APP_VERSION: bad }, real), '0.0.0', bad);
  });
});
