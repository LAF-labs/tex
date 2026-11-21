import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const POC = path.resolve(import.meta.dirname, '..');

const DOT = '·';

const DIRS = [
  'apps/desktop/src',
  'apps/desktop/static/shell',
  'packages/chat-core/src',
  'packages/bundle/src',
  'packages/daemon/src',
  'packages/engine/src/bank',
  'packages/engine/src/issue',
  'packages/engine/src/codef',
];
const FILES = ['packages/engine/src/documents.ts', 'services/account/src/pg-toss.ts'];

const SKIP_FILES: Record<string, string> = {
  'apps/desktop/src/tokens.gen.ts': '디자인 토큰 생성물(설명 주석)',
  'apps/desktop/src/docparse-e2e.ts': '개발용 점검 이름(사용자에게 안 보임)',
  'apps/desktop/src/demo-model.ts': '시연 모델 머리말(2단계에서 정리)',
};

const ALLOW_LINE: Array<{ file: string; re: RegExp; why: string }> = [
  { file: 'apps/desktop/src/cert-docs.ts', re: /건강보험·국민연금공단제출용/, why: '홈택스가 주는 용도 선택지 값' },
  { file: 'apps/desktop/src/counterparty-book.ts', re: /split\(\/\[/, why: '거래처 이름 구분 문자를 읽는 정규식' },
  { file: 'apps/desktop/src/demo-seed.ts', re: /<(p class="m"|table|tr)>/, why: '시연용 가짜 홈택스 페이지' },
  { file: 'packages/chat-core/src/reply-check.ts', re: /\[·ㆍ\]/, why: '모델이 쓴 가운데점을 쉼표로 바꾸는 정규식' },
  { file: 'packages/bundle/src/request-paste.ts', re: /PATTERN = new RegExp|\.split\(\/\\r\?\\n/, why: '붙여 넣은 글을 읽는 정규식' },
];

const walk = (dir: string, out: string[]): void => {
  for (const e of fs.readdirSync(path.join(POC, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walk(rel, out);
    } else if (/\.(ts|tsx|js|mjs|html)$/.test(e.name)) out.push(rel);
  }
};

const isComment = (line: string): boolean => {
  const s = line.trimStart();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*');
};

describe('사용자에게 보이는 문구에 가운데점(·)을 쓰지 않는다', () => {
  it('화면·카드·표·알림 문구 파일에는 가운데점이 없다', () => {
    const files: string[] = [...FILES];
    for (const d of DIRS) walk(d, files);
    assert.ok(files.length > 100, `점검 대상이 너무 적다: ${files.length}`);
    const bad: string[] = [];
    for (const f of files) {
      if (f in SKIP_FILES) continue;
      const lines = fs.readFileSync(path.join(POC, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes(DOT) || isComment(line)) return;
        if (ALLOW_LINE.some((a) => a.file === f && a.re.test(line))) return;
        bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `가운데점은 공백, 쉼표, 줄바꿈, 슬래시 중 자연스러운 것으로 바꾼다:\n${bad.join('\n')}`);
  });

  it('예외 목록은 실제로 쓰이고 있다', () => {
    for (const a of ALLOW_LINE) {
      const hit = fs.readFileSync(path.join(POC, a.file), 'utf8').split('\n').some((l) => l.includes(DOT) && !isComment(l) && a.re.test(l));
      assert.ok(hit, `${a.file}: 예외(${a.why})가 더는 필요 없다. 목록에서 지운다`);
    }
    for (const f of Object.keys(SKIP_FILES)) assert.ok(fs.existsSync(path.join(POC, f)), `${f}가 없다`);
  });
});
