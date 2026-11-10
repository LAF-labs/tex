// scripts/h01-republish.mjs: 셀렉터 수정 → 판 올림 → 재게시 한 명령(팀장 지시 2026-11-09 3, PUBLISH-H01.md "판을 바꿀 때").
// 게시 CLI·서명 CLI는 따로 시험한다(registry-publish). 여기서는 판 올림과, 게시 도구 화면에서 서명 명령을 뽑는 짝맞춤만 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { signCommand, shq } from '../services/registry/src/publish/pipeline.ts';
import * as rp from '../scripts/h01-republish.mjs';

const POC = path.resolve(import.meta.dirname, '..');

describe('h01-republish: 판 올림', () => {
  it('최상위 version만 바꾸고 lookupsUsed[].version·들여쓰기는 그대로다(실제 manifest·playbook)', () => {
    for (const f of ['manifest.json', 'playbook.json']) {
      const text = fs.readFileSync(path.join(POC, rp.H01_DIR, f), 'utf8');
      const cur = JSON.parse(text) as { version: string; lookupsUsed?: { version: string }[] };
      const out = rp.bumpTopVersion(text, '9.9.9');
      const next = JSON.parse(out) as typeof cur;
      assert.equal(next.version, '9.9.9');
      assert.deepEqual({ ...next, version: cur.version }, cur, `${f}: 판 밖은 그대로`);
      assert.equal(out.split('\n').length, text.split('\n').length);
      if (cur.lookupsUsed) assert.deepEqual(next.lookupsUsed, cur.lookupsUsed);
    }
  });
  it('lookupsUsed 판 올림: 그 id 항목만, 줄 수 그대로, 없는 id는 던진다(실제 H-01 manifest)', () => {
    const text = fs.readFileSync(path.join(POC, rp.H01_DIR, 'manifest.json'), 'utf8');
    const out = rp.bumpLookupsUsed(text, 'hometax.invoice.email_status', '9.9.9');
    const m = JSON.parse(out) as { version: string; lookupsUsed: { id: string; version: string }[] };
    const cur = JSON.parse(text) as typeof m;
    assert.deepEqual(m.lookupsUsed.map((l) => l.version), [cur.lookupsUsed[0]!.version, '9.9.9']);
    assert.equal(m.version, cur.version);
    assert.equal(out.split('\n').length, text.split('\n').length);
    assert.throws(() => rp.bumpLookupsUsed(text, 'hometax.nope', '1.0.0'), /h01.lookup_missing/);
    assert.deepEqual(rp.LOOKUP_DIRS.map((d: string) => path.basename(d)), cur.lookupsUsed.map((l) => l.id));
  });
  it('최상위 판이 없으면 던진다', () => assert.throws(() => rp.bumpTopVersion('{\n "id": "x",\n "a": {\n  "version": "1.0.0"\n }\n}', '1.0.1'), /h01.version_missing/));
  it('판 비교는 숫자로(2.1.10 > 2.1.9), 같으면 크지 않다', () => {
    assert.equal(rp.semverGreater('2.1.10', '2.1.9'), true);
    assert.equal(rp.semverGreater('2.1.0', '2.1.0'), false);
    assert.equal(rp.semverGreater('2.0.9', '2.1.0'), false);
    assert.throws(() => rp.semverGreater('2.1', '2.1.0'), /h01.version_invalid/);
  });
  it('원본 목록: 조회 패키지 2개 + H-01(조회는 이미 게시됨으로 서명 없음)', () => {
    assert.deepEqual(rp.SOURCES.map((s: string) => path.basename(s)), ['hometax.invoice.lookup', 'hometax.invoice.email_status', 'hometax.invoice.issue']);
    for (const s of rp.SOURCES) assert.ok(fs.existsSync(path.join(POC, s, 'manifest.json')), s);
  });
});

describe('h01-republish: 게시 도구 화면에서 서명 명령 뽑기(signCommand와 짝)', () => {
  const trust = 'services/registry/ceremony/keyepoch-1/trust-root.json';
  const work = "/Users/me/sax publish/h01-2.1.1 it's";
  const cmd = (kind: 'manifest' | 'index', keyId: string) =>
    signCommand({ kind, keyId, confirm: '2bb4-aa6f-1263-b286-142a-e36e-3440-54da', trust, doc: `${work}/manifests/x.json`, out: `${work}/sig/x.${keyId}.json` });

  it('prepare·assemble 화면의 들여 쓴 sign 줄만 뽑는다', () => {
    const screen = ['계획 …', '  hometax.invoice.lookup(…) manifest abc — 이미 게시됨(서명 없음)', '다음: 서명 2번(Touch ID). 화면의 확인 코드가 위와 같은지 보고 누른다', `  ${cmd('manifest', 'package-1')}`, `  ${cmd('manifest', 'package-2')}`, '그다음: assemble --work …'].join('\n');
    assert.deepEqual(rp.signLines(screen), [cmd('manifest', 'package-1'), cmd('manifest', 'package-2')]);
  });
  // 서명은 맥에서만 한다(스크립트가 win32를 거부). Windows의 signCommand는 큰따옴표로 인용한다
  it('--out·--kind·--key-id·--confirm을 셸 인용째 되읽는다(공백·작은따옴표 경로)', { skip: process.platform === 'win32' }, () => {
    const c = cmd('index', 'package-2');
    assert.equal(shq(`${work}/sig/x.package-2.json`, 'darwin').startsWith("'"), true, '인용되는 경로로 시험한다');
    assert.deepEqual(rp.signParts(c), { kind: 'index', keyId: 'package-2', confirm: '2bb4-aa6f-1263-b286-142a-e36e-3440-54da', out: `${work}/sig/x.package-2.json` });
  });
  it('인용 없는 경로도 그대로', () => {
    const c = signCommand({ kind: 'manifest', keyId: 'package-1', confirm: 'c', trust, doc: '/w/m.json', out: '/w/sig/a.package-1.json' });
    assert.equal(rp.signParts(c).out, '/w/sig/a.package-1.json');
  });
});

describe('h01-republish: 비밀', () => {
  it('토큰을 인자·env로 받지 않는다(--token-env 없음, push는 터미널 입력)', () => {
    const src = fs.readFileSync(path.join(POC, 'scripts/h01-republish.mjs'), 'utf8');
    assert.doesNotMatch(src, /token-env|ADMIN_TOKEN|process\.env/);
  });
});
