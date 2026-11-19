// 은행 자동 연결 실패 문구(shell-bank-auto.js failText). 기업·개인 뱅킹은 사람이 고르지 않고 엔진이 둘 다 해 본다(대표 2026-11-19).
// 둘 다 안 되면 그 은행에서 한 번 할 일만 말한다(2026-11-18·19 실기기: 우리은행 CF-12805 인증서 미등록, CF-12831 본인인증 요구).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
// 정적 JS 모듈(타입 없음). document는 그릴 때만 쓴다
const { failText, otherWayText, withdrawOk, WITHDRAW_LEN_TEXT } = (await import('../apps/desktop/static/shell/shell-bank-auto.js')) as unknown as {
  failText: (code: string, bank?: string, clientType?: 'B' | 'P') => string;
  otherWayText: (also: unknown, bank?: string) => string | null;
  withdrawOk: (digits: string) => boolean;
  WITHDRAW_LEN_TEXT: string;
};
const src = fs.readFileSync(new URL('../apps/desktop/static/shell/shell-bank-auto.js', import.meta.url), 'utf8');

describe('은행 자동 연결 실패 문구', () => {
  it('본인인증 요구·미가입·뱅킹 종류: 그 은행에서 한 번 할 일과 [다시 연결]', () => {
    assert.match(failText('identity_required', '0020', 'B'), /우리은행 기업 인터넷뱅킹에 이 인증서로 한 번 로그인해 주세요.*\[다시 연결\]/);
    assert.match(failText('identity_required', '0020', 'P'), /우리은행 개인 인터넷뱅킹에 이 인증서로/);
    assert.match(failText('not_enrolled', '0020'), /인터넷뱅킹 가입이 먼저/);
    assert.match(failText('banking_kind', '0020'), /기업 인터넷뱅킹에 묶여/);
  });
  it('인증서 미등록: 타기관 인증서 등록 한 번', () => {
    assert.match(failText('cert_not_registered', '0004', 'B'), /국민은행 인터넷뱅킹에서 \[인증센터 > 타기관 인증서 등록\]/);
  });
  it('뱅킹을 바꾸라는 말을 하지 않는다(앱이 이미 둘 다 해 봤다)', () => {
    for (const c of ['identity_required', 'cert_not_registered']) for (const k of ['B', 'P'] as const) assert.doesNotMatch(failText(c, '0020', k), /\[개인 뱅킹으로 다시\]|\[사업자로 다시\]|\[개인\]|\[사업자\]/);
  });
  it('SMS 인증번호가 틀리면 [다시 시도]로 새 번호를 받는다', () => {
    assert.match(failText('sms_wrong', '0020'), /\[다시 시도\]/);
  });
  it('화면 글에 CODEF 코드·개발 용어가 없다', () => {
    for (const c of ['cert_not_registered', 'identity_required', 'sms_wrong', 'bank_error', 'nope']) {
      for (const k of ['B', 'P'] as const) assert.doesNotMatch(failText(c, '0020', k), /CF-\d|clientType|CODEF|connectedId|2-way/);
    }
  });
});

describe('자동 연결 카드', () => {
  it('계좌 종류(사업자/개인) 고르기가 없다', () => {
    assert.doesNotMatch(src, /계좌 종류/);
  });
  it('SMS 단계: 인증번호 칸 하나와 [확인], 번호는 보낸 뒤 화면 상태에서 지운다', () => {
    assert.match(src, /case 'sms':/);
    assert.match(src, /autocomplete: 'one-time-code'/);
    assert.match(src, /go\(\{ step: 'working', phase: 'accounts', smsCode: '' \}\)/);
  });
  it('은행이 계좌번호를 같이 확인하자고 하면 계좌번호 칸 하나', () => {
    assert.match(src, /case 'withdraw':/);
    assert.match(src, /r\.code === 'withdraw_account_required'\)\s*return go\(\{ step: 'withdraw'/);
  });
});

// 2026-11-19 실기기(라프·우리은행): 계좌번호 칸에 4자리를 넣고 세 번 실패했는데 번호는 은행에 가지도 않았고 화면은 "은행이 받지 않았어요"였다.
// 기업 뱅킹 본인인증(CF-12831) 안내도 계좌번호 카드에 가려 보이지 않았다.
describe('계좌번호 카드: 덜 넣은 번호·다른 길', () => {
  it('계좌번호는 숫자 10~16자리만 보낸다', () => {
    assert.equal(withdrawOk('0200'), false);
    assert.equal(withdrawOk('100212345'), false);
    assert.equal(withdrawOk('1002123456789'), true);
    assert.equal(withdrawOk('12345678901234567'), false);
    assert.match(WITHDRAW_LEN_TEXT, /10~16자리/);
  });
  it('덜 넣은 번호는 비밀번호를 묻기 전에 칸에서 알린다(은행이 받지 않았다고 말하지 않는다)', () => {
    const connect = src.slice(src.indexOf('async function connect()'), src.indexOf('function landed('));
    const check = connect.indexOf('!withdrawOk(withdraw)) return go({ msg: WITHDRAW_LEN_TEXT })');
    assert.ok(check > 0, '길이 확인이 connect 안에 있다');
    assert.ok(check < connect.indexOf("go({ step: 'working', phase: 'password'"), '금고 창을 열기 전에 막는다');
    assert.match(connect, /msg: withdrawOk\(withdraw\) \? `\$\{bankName\(s\.bank\)\}이 이 계좌번호를 받지 않았어요/);
  });
  it('기업 뱅킹이 본인인증을 요구하면 계좌번호 대신 은행에서 한 번 로그인하는 길도 한 줄로', () => {
    assert.match(otherWayText({ clientType: 'B', code: 'identity_required' }, '0020')!, /또는 우리은행 기업 인터넷뱅킹에 이 인증서로 한 번 로그인한 뒤, 칸을 비운 채 \[계속\]/);
    assert.match(otherWayText({ clientType: 'B', code: 'banking_kind' }, '0020')!, /우리은행 기업 인터넷뱅킹/);
    assert.match(otherWayText({ clientType: 'B', code: 'cert_not_registered' }, '0004')!, /국민은행 인터넷뱅킹에서 \[인증센터 > 타기관 인증서 등록\]/);
    assert.match(src, /'data-bank-other-way'/);
  });
  it('사람이 할 일이 아니면 줄을 더하지 않고, 화면 글에 코드가 없다', () => {
    assert.equal(otherWayText(null, '0020'), null);
    assert.equal(otherWayText({ clientType: 'B', code: 'bank_error' }, '0020'), null);
    for (const code of ['identity_required', 'banking_kind', 'cert_not_registered']) {
      for (const clientType of ['B', 'P']) assert.doesNotMatch(otherWayText({ clientType, code }, '0020') ?? '', /CF-\d|clientType|CODEF|identity_required/);
    }
  });
});
