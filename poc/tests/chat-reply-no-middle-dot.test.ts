import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAgentReply } from '@sax/chat-core';

const ctx = {
  kinds: new Set(['answer', 'smalltalk']),
  asks: new Set<string>(),
  hasToken: () => true,
  hasRef: () => true,
  canShow: () => true,
  fallbackText: '다시 말씀해 주세요.',
  numberText: '표로 보여 드려요.',
};

describe('대화 답에 가운데점(·)을 쓰지 않는다', () => {
  it('모델이 가운데점을 써도 쉼표로 바꿔 보여 준다', () => {
    const r = checkAgentReply({ kind: 'answer', text: '발급 기록 조회·세금계산서 발급은 바로 도와드려요 · 말씀만 하세요', show: [], ask: null }, ctx);
    assert.equal(r.filtered, null);
    assert.ok(!/[·ㆍ]/.test(r.text), r.text);
    assert.equal(r.text, '발급 기록 조회, 세금계산서 발급은 바로 도와드려요, 말씀만 하세요');
  });
});
