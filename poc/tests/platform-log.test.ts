// FileEventLog 줄 형식: 머리 키(at·c·code)는 필드가 덮지 못한다(WIN-REALDEVICE §7: main.engine_exit {code: 1}이 `{"code":1}`로만 남던 문제).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileEventLog } from '@sax/platform';

describe('FileEventLog', () => {
  it('필드 이름이 code·at·c여도 이벤트 이름·시각·구성 요소를 덮지 않고 `<키>_`로 남긴다', () => {
    const log = new FileEventLog(null, 'main');
    log.event('main.engine_exit', { code: 1 });
    log.event('run.signal', { runId: 'r1', code: 'blocked_page', at: 'x', c: 'y' });
    const [a, b] = log.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(a!.code, 'main.engine_exit');
    assert.equal(a!.c, 'main');
    assert.equal(a!.code_, 1);
    assert.equal(b!.code, 'run.signal');
    assert.equal(b!.code_, 'blocked_page');
    assert.equal(b!.c, 'main');
    assert.equal(b!.c_, 'y');
    assert.equal(b!.at_, 'x');
    assert.match(String(b!.at), /^\d{4}-\d{2}-\d{2}T/);
  });

  it('ID·코드 모양이 아닌 문자열은 여전히 [dropped]', () => {
    const log = new FileEventLog(null, 'engine');
    log.event('x', { code: 'has space', note: '가나다' });
    const o = JSON.parse(log.lines[0]!) as Record<string, unknown>;
    assert.equal(o.code, 'x');
    assert.equal(o.code_, '[dropped]');
    assert.equal(o.note, '[dropped]');
  });
});
