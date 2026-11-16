// 화면 보기 칸(computer-use, 대표 결정 2026-11-16): 가린 사진만 나가고(PC 검사기·사진 가리기), 모델이 찍은 좌표는 그 자리 요소로 바뀌어
// 브라우저 에이전트와 같은 가드로 실행되며, 넘긴 길은 에이전트 길 기억에 남아 다음에는 모델 없이 다시 걷는다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { AgentPathMemory, BrowserAgent, PlaywrightActuator, PlaywrightPageReader, type AgentPathFile, type JsonStore, type VisionModel } from '@sax/engine';
import { newScope, type PlaybookIR, type SelectorDict, type Step } from '@sax/engine/core';
import { MASKED_SHOT_MAX_BYTES, type MaskedShot } from '@sax/model';
import { ModelGuard, SHOT_MAX_BYTES } from '@sax/net';
import { apply } from '@sax/redaction';

const JPEG = 'data:image/jpeg;base64,/9j/AAAA' as MaskedShot;
const txt = () => ({ type: 'input_text' as const, text: apply('[목표] s1 fill item', { runId: 'r' }, { frame: 'none' }).redacted });

describe('화면 보기: PC 검사기(ModelGuard)', () => {
  it('사진은 computer_use에만, 한 장, JPEG data URL, 상한 안. 공급사 본문에 다른 사진이 끼면 거부', () => {
    assert.equal(SHOT_MAX_BYTES, MASKED_SHOT_MAX_BYTES);
    const g = new ModelGuard({ bundles: [] });
    const runToken = g.issueRunToken({ runId: 'r-cu' });
    const body = (toolset: string, content: unknown[]) => ({ toolset, messages: [{ role: 'user', content }], runToken }) as never;
    g.inspect('respond', body('computer_use', [txt(), { type: 'input_image', image_url: JPEG }]));
    const bad: Array<[string, unknown[], unknown?]> = [
      ['browser_agent', [txt(), { type: 'input_image', image_url: JPEG }]],
      ['computer_use', [txt(), { type: 'input_image', image_url: JPEG }, { type: 'input_image', image_url: JPEG }]],
      ['computer_use', [txt(), { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]],
      ['computer_use', [txt(), { type: 'input_image', image_url: `data:image/jpeg;base64,${'A'.repeat(SHOT_MAX_BYTES)}` }]],
      ['computer_use', [txt(), { type: 'input_image', image_url: JPEG }], { input: [{ type: 'input_image', image_url: JPEG }, { type: 'input_image', image_url: JPEG }] }],
    ];
    for (const [t, c, provider] of bad) assert.throws(() => (provider ? g.inspect('respond', body(t, c), provider) : g.inspect('respond', body(t, c))), (e: { code?: string }) => e.code === 'image_rejected' || e.code === 'schema_rejected', t);
  });
});

const HTML = `<!doctype html><html><body style="margin:0;font:16px sans-serif;background:#fff">
<div style="padding:20px">사업자 123-45-67890 · 메일 tax@example.com</div>
<label for="itemX" style="display:inline-block;width:80px">품목</label><input id="itemX" value="이미 넣은 값 9876" style="width:300px;height:40px;background:#fff;color:#000">
<div style="height:30px"></div><button id="ok" style="width:120px;height:40px">다음</button>
</body></html>`;

describe('화면 보기: 실제 Chromium', () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SAX_CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }).catch(() => chromium.launch({ channel: 'chrome', headless: true }));
    page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  });
  after(() => browser?.close());

  it('maskedShot: 입력 칸·숫자 글·메일 글은 검게, 이름표는 그대로. 크기 상한 안', async () => {
    await page.setContent(HTML);
    const r = new PlaywrightPageReader(page);
    const shot = await r.maskedShot();
    assert.ok(shot && shot.url.startsWith('data:image/jpeg;base64,') && shot.url.length <= MASKED_SHOT_MAX_BYTES);
    assert.deepEqual([shot.width, shot.height], [800, 400]);
    // 찍은 사진을 다른 탭에 그려 픽셀을 본다(입력 칸 가운데·숫자 글·이름표)
    const input = (await page.locator('#itemX').boundingBox())!;
    const num = (await page.getByText(/123-45/).boundingBox())!;
    const label = (await page.locator('label').boundingBox())!;
    const p2 = await browser.newPage();
    const px = await p2.evaluate(async ({ url, pts }) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3));
    }, { url: shot.url, pts: [[input.x + input.width / 2, input.y + input.height / 2], [num.x + 5, num.y + num.height / 2], [label.x + 2, label.y + 2]] });
    await p2.close();
    const dark = (c: number[]) => c.every((v) => v < 40);
    assert.ok(dark(px[0]!), `입력 칸 ${px[0]}`);
    assert.ok(dark(px[1]!), `숫자 글 ${px[1]}`);
    assert.ok(!dark(px[2]!), `이름표 바탕은 그대로 ${px[2]}`);
  });

  it('vision: 좌표 → 그 자리 입력 칸 → 값토큰을 이번 실행 값으로 넣고 돌아갈 스텝. 넘긴 길은 기억에 남는다', async () => {
    await page.setContent(HTML);
    const reader = new PlaywrightPageReader(page);
    const act = new PlaywrightActuator({ page, reader });
    const dict = {
      entries: {
        root: { candidates: [{ kind: 'css', value: 'body' }], role: 'generic', namePattern: '^.*$', frame: 'main', landmark: 'root', commits: false, lastVerified: 'x' },
        item: { candidates: [{ kind: 'css', value: '#itemOld' }], role: 'textbox', namePattern: '^품목$', frame: 'main', landmark: 'root', commits: false, lastVerified: 'x' },
      },
    } as unknown as SelectorDict;
    const steps = [{ id: 's1', type: 'fill', target: 'item', value: '$inputs.items[0].name' }, { id: 's2', type: 'assert', cond: { always: true } }, { id: 's3', type: 'end', status: 'success' }] as unknown as Step[];
    const ir = { ir: 2, id: 't', version: '1', steps } as unknown as PlaybookIR;
    let file: AgentPathFile | null = null;
    const store: JsonStore<AgentPathFile> = { read: () => file, write: (v) => void (file = JSON.parse(JSON.stringify(v))) };
    const paths = new AgentPathMemory(store);
    const seen: string[] = [];
    const vision: VisionModel = {
      async next(req) {
        seen.push(req.shot.url.slice(0, 23));
        if (req.history.length) return { action: 'done', x: null, y: null, token: null, step: null };
        const b = (await page.locator('#itemX').boundingBox())!;
        return { action: 'type', x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), token: req.goal[0]!.token, step: 's1' };
      },
    };
    const journal: string[] = [];
    const agent = new BrowserAgent({
      page: reader, dict, act: act as never, frame: 'main', journal: (t) => journal.push(t), ir, scope: newScope({ inputs: { items: [{ name: '사과 한 상자' }] } }),
      irreversible: new Set(), model: { next: async () => null }, paths, vision,
    });
    assert.equal(agent.visionable('s1'), true);
    assert.equal(await agent.vision('s1'), 's2');
    assert.equal(await page.locator('#itemX').inputValue(), '사과 한 상자');
    assert.deepEqual(seen, ['data:image/jpeg;base64,', 'data:image/jpeg;base64,']);
    paths.confirmed('s2');
    assert.equal(file!.paths.s1!.actions[0]!.el!.id, 'itemX');
    assert.ok(!JSON.stringify(file).includes('사과'), '값은 남기지 않는다');
    // 다음 실행: 같은 길을 모델 없이(다시 걷기)
    await page.setContent(HTML);
    const again = new BrowserAgent({
      page: reader, dict, act: act as never, frame: 'main', journal: (t) => journal.push(t), ir, scope: newScope({ inputs: { items: [{ name: '배 두 상자' }] } }),
      irreversible: new Set(), model: { next: async () => null }, paths: new AgentPathMemory(store),
    });
    assert.equal(again.replayable('s1'), true);
    assert.equal(await again.replay('s1'), 's2');
    assert.equal(await page.locator('#itemX').inputValue(), '배 두 상자');
    // 기록 때 id가 없던 요소가 지금은 id를 가져도 역할·이름이 유일하면 맞힌다
    file!.paths.s1!.actions[0]!.el!.id = null;
    await page.setContent(HTML);
    const third = new BrowserAgent({
      page: reader, dict, act: act as never, frame: 'main', journal: (t) => journal.push(t), ir, scope: newScope({ inputs: { items: [{ name: '귤 세 상자' }] } }),
      irreversible: new Set(), model: { next: async () => null }, paths: new AgentPathMemory(store),
    });
    assert.equal(await third.replay('s1'), 's2', journal.join(','));
    assert.equal(await page.locator('#itemX').inputValue(), '귤 세 상자');
  });

  it('vision: 좌표가 금지 이름(발급) 단추를 가리키면 가드가 거부하고 두 번 거부되면 멈춘다', async () => {
    await page.setContent(HTML.replace('>다음<', '>발급하기<'));
    const reader = new PlaywrightPageReader(page);
    const act = new PlaywrightActuator({ page, reader });
    let clicked = 0;
    await page.exposeFunction('__hit', () => void clicked++);
    await page.evaluate(() => document.getElementById('ok')!.addEventListener('click', () => (window as unknown as { __hit: () => void }).__hit()));
    const dict = { entries: { root: { candidates: [{ kind: 'css', value: 'body' }], role: 'generic', namePattern: '^.*$', frame: 'main', landmark: 'root', commits: false, lastVerified: 'x' }, item: { candidates: [{ kind: 'css', value: '#nope' }], role: 'textbox', namePattern: '^품목$', frame: 'main', landmark: 'root', commits: false, lastVerified: 'x' } } } as unknown as SelectorDict;
    const ir = { ir: 2, id: 't', version: '1', steps: [{ id: 's1', type: 'fill', target: 'item', value: '$inputs.x' }, { id: 's2', type: 'end', status: 'success' }] } as unknown as PlaybookIR;
    const b = (await page.locator('#ok').boundingBox())!;
    const vision: VisionModel = { next: async () => ({ action: 'click', x: Math.round(b.x + 10), y: Math.round(b.y + 10), token: null, step: 's1' }) };
    const journal: Array<[string, unknown]> = [];
    const agent = new BrowserAgent({ page: reader, dict, act: act as never, frame: 'main', journal: (t, p) => journal.push([t, p]), ir, scope: newScope({ inputs: { x: 'v' } }), irreversible: new Set(), model: { next: async () => null }, vision });
    assert.equal(await agent.vision('s1'), null);
    assert.equal(clicked, 0);
    const codes = journal.filter(([t]) => t === 'computer_use.action').map(([, p]) => (p as { result: string }).result);
    assert.deepEqual(codes, ['agent.deny_name', 'agent.deny_name']);
  });
});
