// 대화로 앱 화면 열기(open_screen)와 이름만 말하는 답(대표 지적 2026-11-19 "에이전틱하지 않잖아", "어떤 말을 던져도 자연스럽게").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { CHAT_AGENT_TOOLS, CHAT_PHONE_TOOLS, OPEN_SCREENS, PHONE_SCREENS, unsafeText } from '@sax/chat-core';

describe('open_screen 도구', () => {
  it('PC 도구 표의 화면은 PC 화면이고, 폰은 같은 이름으로 폰 화면(PHONE_SCREENS)만 연다', () => {
    const t = CHAT_AGENT_TOOLS.find((x) => x.name === 'open_screen');
    assert.ok(t);
    assert.deepEqual((t.parameters.properties as { screen: { enum: readonly string[] } }).screen.enum, OPEN_SCREENS);
    const phone = CHAT_PHONE_TOOLS.filter((x) => (x.name as string) === 'open_screen');
    assert.equal(phone.length, 1);
    assert.deepEqual((phone[0]!.parameters.properties as { screen: { enum: readonly string[] } }).screen.enum, [...PHONE_SCREENS]);
  });
  it('보안카드는 열 화면이 없다(지원하지 않음, 대표 2026-11-19)', () => {
    assert.ok(!(OPEN_SCREENS as readonly string[]).some((s) => /card/.test(s)));
  });
  it('렌더러가 모든 화면 이름을 안다', () => {
    const js = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    for (const s of OPEN_SCREENS) assert.match(js, new RegExp(`\\b${s}\\b`), s);
  });
  it('머리말이 화면 이름을 모두 적고, 목록을 되풀이하지 말라고 하고, 잡담에도 사람처럼 답하라고 한다', () => {
    const p = fs.readFileSync(new URL('../packages/model/toolsets/chat_agent.ko.txt', import.meta.url), 'utf8');
    for (const s of OPEN_SCREENS) assert.ok(p.includes(`${s}(`), s);
    assert.match(p, /할 수 있는 일 목록을 되풀이하지 말고 open_screen/);
    assert.match(p, /업무와 상관없는 말/);
    assert.doesNotMatch(p, /security_card/);
  });
});

describe('답 검사: 인증서·보안카드 이름만 말하는 것은 통과, 값을 달라는 말은 막는다', () => {
  it('이름만', () => {
    assert.equal(unsafeText('공동인증서나 간편인증을 쓰면 돼요. 발급 인증 화면을 열었어요.'), false);
  });
  it('값을 달라는 말', () => {
    for (const t of ['인증서 비밀번호를 알려 주세요', '보안카드 번호를 적어 주세요', '인증서 암호를 말씀해 주세요', '비밀번호 입력하세요']) assert.equal(unsafeText(t), true, t);
  });
});
