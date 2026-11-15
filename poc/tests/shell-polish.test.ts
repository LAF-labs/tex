// 실사용 잔손질(부장 지시 2026-11-11): 내 사업장의 내용 없는 개인 카드, 화면 문구의 내부 코드·개발 용어, 오류 코드가 그대로 보이던 토스트.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { NOTE } from '../apps/desktop/src/shell-runs.ts';

const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SHELL = ['shell.js', 'shell-views.js', 'shell-g24.js', 'shell-onboarding.js', 'shell-account.js', 'shell-biz.js'].map((f) => [f, read(`apps/desktop/static/shell/${f}`)] as const);

describe('내 사업장: 저장된 개인 프로필이 없으면 카드를 그리지 않는다', () => {
  it('제품의 개인 자리는 placeholder, 렌더러는 그 카드를 건너뛰고 사용 수에도 넣지 않는다', () => {
    assert.match(read('apps/desktop/src/shell-app.ts'), /const NO_PERSONAL: Profile = \{ kind: 'personal', name: '개인', email: '', auth: '', placeholder: true \};/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /const personal = p\.personal && !p\.personal\.placeholder \? p\.personal : null;/);
    // v2.0: 내 사업장 머리의 "프로필 2개 중 n개 사용"은 지웠다(사장님에게 의미 없는 수). 개인 자리는 여전히 건너뛴다.
    // 제목줄 프로필 메뉴도 저장된 개인 프로필이 있을 때만 "개인"을 보인다
    assert.match(shell, /p\.personal && !p\.personal\.placeholder \? item\('personal', `개인 · \$\{p\.personal\.name\}`\) : null/);
  });
});

describe('화면 문구에 내부 코드·개발 용어가 없다(시연 전용 분기 밖)', () => {
  it('토스트·안내에 "목업:"·"데모에서는"·F-06 확정 문장·카드 머리의 O-0x 표시가 없다', () => {
    for (const [f, s] of SHELL) {
      assert.doesNotMatch(s, /toast\('목업|toast\('데모|'목업:/, f);
      assert.doesNotMatch(s, /F-06이 확정되면/, f);
      assert.doesNotMatch(s, /'sx-meta' \}, 'O-0\d'/, f);
      assert.doesNotMatch(s, /이 데모에서는 켤 수 없어요|'미리보기 자리\(목업\)'/, f);
    }
  });
  it('엔진 멈춤 문구에 PoC가 없다', () => {
    for (const [k, v] of Object.entries(NOTE)) assert.ok(!/PoC|목업|데모/.test(v!), `${k}: ${v}`);
  });
  it('오류 토스트는 코드를 그대로 보이지 않는다: 화면 표 → 공통 표 → 일반 문장', () => {
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /const human = \(e, table = \{\}\) => \{\s*const c = errText\(e\);\s*return table\[c\] \|\| COMMON_ERR\[c\] \|\| GENERIC_ERR;\s*\};/);
    assert.doesNotMatch(shell, /toast\(errText\([a-z]+\)\)/);
    assert.doesNotMatch(shell, /\?\? errText\(/);
    assert.doesNotMatch(shell, /\|\| errText\(/);
    assert.doesNotMatch(shell, /: errText\(e\)\);/);
  });
});
