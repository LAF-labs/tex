// 오프라인 세무 상담 낱말 사전(advice-words.ts, D04 §3, 팀장 결정 2026-11-07): 걸려야 할 문장과 걸리면 안 되는 문장, 배선.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { offlineAdviceMentioned, OFFLINE_ADVICE_PATTERNS } from '../apps/desktop/src/advice-words.ts';

describe('오프라인 세무 상담 낱말', () => {
  it('공제·절세·경비 인정·세액 판단을 묻는 말은 걸린다', () => {
    const hit = [
      '부가세 줄이는 방법 알려줘',
      '절세 방법 좀',
      '세금 아끼려면 어떻게 해?',
      '이거 경비 처리 돼요?',
      '이 카드값 경비로 넣어도 돼?', // D04 §3 예시
      '노트북 비용으로 처리할 수 있나요',
      '의료비 공제 받을 수 있어?',
      '이거 공제 대상이에요?',
      '종소세 얼마 내야 해?',
      '부가세 얼마나 나와?',
      '법인세는 몇 내?',
      '환급 받을 수 있나요',
      '감면 가능해요?',
      '가산세 안 내려면',
      '신고 안 하면 어떻게 돼?',
      '세무 상담 좀 해 줘',
      'A상사에 100만원 세금계산서 끊고 절세 방법도 알려줘',
    ];
    for (const t of hit) assert.equal(offlineAdviceMentioned(t), true, t);
  });

  it('발급·증명서·조회 요청과 급여 계산 요청은 걸리지 않는다', () => {
    const miss = [
      'A상사에 330만원 세금계산서 끊어줘',
      '부가세 포함 330만원 세금계산서',
      '부가세 별도로 220만원',
      '세금계산서 메일로 보내 줘',
      '납세증명서 떼 줘',
      '사업자등록증명 떼 줘',
      '소득공제 증명서 발급',
      '공제증명서 떼 줘',
      '이번 달 원천세 얼마야', // D04 §3: 급여 계산 요청은 상담이 아니다
      'A상사에 얼마 발급했지?',
      '경비 내역 정리해 줘',
      '사업용 카드 내역 최신화',
      '부가세 신고 언제야?',
      '환급금 들어왔는지 봐 줘',
      '세금계산서 조회',
      '급여대장 만들어 줘',
      '안녕',
    ];
    for (const t of miss) assert.equal(offlineAdviceMentioned(t), false, t);
  });

  it('사전은 상수 파일 하나, 띄어쓰기를 지우고 맞춘다', () => {
    assert.ok(OFFLINE_ADVICE_PATTERNS.length > 0);
    assert.equal(offlineAdviceMentioned('경 비 처 리 돼요'), true);
  });

  it('판정 불가(decide.unavailable)일 때만 고정 문구를 덧붙이고, 작업(interpret)은 그대로다', () => {
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    assert.ok(src.includes("if (!r.route) return finishReply(interpret(text, vat, profile, runs, local), via, r.fallback === 'decide.unavailable' && offlineAdviceMentioned(text) ? ADVICE_TEXT : null, sent);"));
    // 온라인 길(routed)은 모델 판정 그대로: 사전을 다른 곳에서 부르지 않는다
    assert.equal(src.split('offlineAdviceMentioned(').length - 1, 1);
  });
});
