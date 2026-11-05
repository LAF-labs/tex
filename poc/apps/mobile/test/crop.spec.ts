import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitEdge, guideCrop, guideRect } from '../src/capture/crop.ts';

describe('안내 틀 자르기', () => {
  it('세로 사진을 같은 비율 미리보기에 놓으면 비례 변환', () => {
    const r = guideCrop({ width: 3000, height: 4000 }, { width: 300, height: 400 }, { x: 30, y: 40, w: 240, h: 320 });
    assert.deepEqual(r, { originX: 300, originY: 400, width: 2400, height: 3200 });
  });
  it('미리보기가 더 길쭉하면(cover) 사진 좌우가 잘려 보인다', () => {
    // 사진 3000x4000, 화면 390x844 → scale = 844/4000 = 0.211, 보이는 폭 = 1848, 좌우 576씩 잘림
    const r = guideCrop({ width: 3000, height: 4000 }, { width: 390, height: 844 }, { x: 0, y: 0, w: 390, h: 844 });
    assert.equal(r.originY, 0);
    assert.equal(r.height, 4000);
    assert.ok(Math.abs(r.originX - 576) <= 1);
    assert.ok(Math.abs(r.width - 1848) <= 1);
  });
  it('사진 밖으로 나가지 않는다', () => {
    const r = guideCrop({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 90, y: 90, w: 50, h: 50 });
    assert.deepEqual(r, { originX: 90, originY: 90, width: 10, height: 10 });
  });
  it('안내 틀은 화면 안 가운데', () => {
    const g = guideRect({ width: 390, height: 700 });
    assert.ok(g.x > 0 && g.y > 0 && g.x + g.w <= 390 && g.y + g.h <= 700);
    assert.ok(Math.abs(g.h / g.w - 1.6) < 1e-9);
  });
  it('긴 변 줄이기', () => {
    assert.equal(fitEdge(2000, 1000, 2400), null);
    assert.deepEqual(fitEdge(3000, 4000, 2400), { width: 1800, height: 2400 });
  });
});
