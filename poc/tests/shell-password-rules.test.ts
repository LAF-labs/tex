// 비밀번호 칸의 조건 3줄(인계 명세 §3.1): 렌더러 미리 보기가 서버 정책(services/account checkPasswordPolicy)과 같은 판정을 내는지 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { checkPasswordPolicy, CommonPasswords, COMMON_PASSWORDS_FILE } from '../services/account/src/password.ts';
// @ts-expect-error 렌더러 정적 모듈(JS, 형 선언 없음)
import { COMMON_10 } from '../apps/desktop/static/shell/common-passwords.js';
// @ts-expect-error 렌더러 정적 모듈(JS, 형 선언 없음)
import { identityIn, PW_MAX, PW_MIN, pwRules } from '../apps/desktop/static/shell/password-rules.js';

type Rules = { len: string; common: string; identity: string; identityKind: 'email' | 'service' | null; tooLong: boolean; ok: boolean };
const rules = pwRules as (pw: string, email: string) => Rules;
const common = CommonPasswords.fromFile(fileURLToPath(COMMON_PASSWORDS_FILE));
const serverCode = (pw: string, email: string): string | null => {
  try {
    checkPasswordPolicy(pw, email, common);
    return null;
  } catch (e) {
    return (e as { code: string }).code;
  }
};

describe('비밀번호 조건 3줄(렌더러 미리 보기 = 서버 정책)', () => {
  it('번들 목록은 서버 목록의 10자 이상 항목과 정확히 같다(서버 목록이 바뀌면 common-passwords.js를 다시 만든다)', () => {
    const text = gunzipSync(fs.readFileSync(COMMON_PASSWORDS_FILE)).toString('utf8');
    const want = new Set(text.split('\n').map((w) => w.trim().normalize('NFKC').toLowerCase()).filter((w) => [...w].length >= PW_MIN));
    const got = COMMON_10 as Set<string>;
    assert.equal(got.size, want.size);
    assert.deepEqual([...got].filter((w) => !want.has(w)), []);
    assert.deepEqual([...want].filter((w) => !got.has(w)), []);
    assert.equal(PW_MIN, 10);
    assert.equal(PW_MAX, 128);
  });

  it('10자 미만은 세 줄 모두 아직(목록·이름 결과를 미리 보이지 않는다)', () => {
    for (const pw of ['', 'owner', '123456789', 'sovereign']) assert.deepEqual(rules(pw, 'owner@gyeonbon-test.example'), { len: 'wait', common: 'wait', identity: 'wait', identityKind: null, tooLong: false, ok: false });
  });

  it('서버와 같은 판정: 흔한 목록·이메일 전체·로컬 부분(3자 이상)·서비스 이름(대소문자·NFKC), 128자 초과', () => {
    const email = 'owner@gyeonbon-test.example';
    const cases: Array<[string, string, string | null]> = [
      ['mangwon-kimchi-12', email, null],
      ['1234567890', email, 'account.password_breached'],
      ['QWERTYUIOP', email, 'account.password_breached'],
      ['ｑｗｅｒｔｙｕｉｏｐ', email, 'account.password_breached'],
      ['my-owner-pass-9', email, 'account.password_contains_identity'],
      ['xx-OWNER@GYEONBON-TEST.EXAMPLE', email, 'account.password_contains_identity'],
      ['ab-cd-ef-gh-12', 'ab@x.example', null],
      ['SovereignAX-2026', email, 'account.password_contains_identity'],
      ['my-소버린-pass1', email, 'account.password_contains_identity'],
      ['a'.repeat(129), email, 'account.password_too_long'],
      ['가나다라마바사아자차', email, null],
    ];
    for (const [pw, e, code] of cases) {
      assert.equal(serverCode(pw, e), code, `서버 ${pw}`);
      const r = rules(pw, e);
      const app = r.tooLong ? 'account.password_too_long' : r.identity === 'bad' ? 'account.password_contains_identity' : r.common === 'bad' ? 'account.password_breached' : null;
      assert.equal(app, code, `앱 ${pw}`);
      assert.equal(r.ok, code === null, pw);
    }
  });

  it('이메일과 서비스 이름을 가른다(서버는 한 코드로 준다, 인계 명세 §3.2)', () => {
    assert.equal(identityIn('my-owner-pass-9', 'owner@gyeonbon-test.example'), 'email');
    assert.equal(identityIn('Sovereign-is-mine', 'owner@gyeonbon-test.example'), 'service');
    assert.equal(identityIn('mangwon-kimchi-12', 'owner@gyeonbon-test.example'), null);
  });
});
