import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { identityLines } from '../src/pairing/identity.ts';

describe('계정 확인 문구(설계 #120)', () => {
  it('검증된 이메일은 전체로, PC 이름은 받은 그대로', () => {
    assert.deepEqual(identityLines({ accountEmail: 'owner@example.test', desktopName: '사무실 PC' }), { account: 'owner@example.test', pc: '사무실 PC' });
  });
  it('값이 없으면 없다고 말한다', () => {
    assert.deepEqual(identityLines({ accountEmail: null, desktopName: null }), { account: '계정 정보 없음', pc: '알려 준 이름 없음' });
  });
});
