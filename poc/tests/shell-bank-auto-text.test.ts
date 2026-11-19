// 은행 자동 연결 실패 문구(shell-bank-auto.js failText). 2026-11-18 실기기: 우리은행·사업자로 연결하자 CF-12805(인증서 미등록)로 거절됐다.
// 1인 사업자는 개인 인터넷뱅킹에만 인증서를 등록한 경우가 많아, 고른 뱅킹(기업/개인)을 짚고 다른 쪽으로 다시 하는 길을 준다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// 정적 JS 모듈(타입 없음). document는 그릴 때만 쓴다
const { failText } = (await import('../apps/desktop/static/shell/shell-bank-auto.js')) as unknown as {
  failText: (code: string, bank?: string, clientType?: 'B' | 'P') => string;
};

describe('은행 자동 연결 실패 문구', () => {
  it('인증서 미등록: 사업자로 고르면 기업 뱅킹을 짚고 [개인 뱅킹으로 다시]를 안내한다', () => {
    const t = failText('cert_not_registered', '0020', 'B');
    assert.match(t, /우리은행 기업 인터넷뱅킹에 등록돼 있지 않아요/);
    assert.match(t, /\[개인 뱅킹으로 다시\]/);
  });
  it('인증서 미등록: 개인으로 고르면 개인 뱅킹을 짚고 [사업자로 다시]를 안내한다', () => {
    const t = failText('cert_not_registered', '0004', 'P');
    assert.match(t, /국민은행 개인 인터넷뱅킹에 등록돼 있지 않아요/);
    assert.match(t, /\[사업자로 다시\]/);
  });
  it('계좌 종류를 모르면 사업자(기본값)로 본다', () => {
    assert.equal(failText('cert_not_registered', '0020'), failText('cert_not_registered', '0020', 'B'));
  });
  it('화면 글에 CODEF 코드·개발 용어가 없다', () => {
    for (const c of ['cert_not_registered', 'identity_required', 'bank_error', 'nope']) {
      for (const k of ['B', 'P']) assert.doesNotMatch(failText(c, '0020', k), /CF-\d|clientType|CODEF|connectedId/);
    }
  });
});
