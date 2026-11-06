import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { identityLines, maskEmail } from '../src/pairing/identity.ts';

describe('계정 이메일 가리기(설계 #120 확인 화면)', () => {
  it('앞 두 글자와 도메인만 보인다', () => {
    assert.equal(maskEmail('owner@example.test'), 'ow•••@example.test');
    assert.equal(maskEmail('ab@x.kr'), 'a•••@x.kr');
    assert.equal(maskEmail('a@x.kr'), 'a•••@x.kr');
    assert.equal(maskEmail('김사장@메일.kr'), '김사•••@메일.kr');
  });
  it('모양이 틀리면 null', () => {
    for (const e of ['', '@x.kr', 'owner@', 'owner']) assert.equal(maskEmail(e), null, e);
  });
  it('값이 없으면 받지 못했다고 말한다', () => {
    assert.deepEqual(identityLines({ desktopName: null, accountEmailMasked: null }), { pc: '이름을 받지 못했어요', account: '계정 정보를 받지 못했어요' });
    assert.deepEqual(identityLines({ desktopName: '사무실 PC', accountEmailMasked: 'ow•••@example.test' }), { pc: '사무실 PC', account: 'ow•••@example.test' });
  });
});
