// 활동 기록의 모델·우리 서버 줄은 실제 송신(run.sent)으로만 만든다(팀장 결정 2026-11-07: "via + 실제 송신 대상", 사실과 다르면 안 된다).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { GATEWAY_ORIGIN } from '@sax/net';
import { GatewayAuthHost } from '../apps/desktop/src/gateway-auth.ts';
import { sentFromGateway } from '../apps/desktop/src/shell-mock.ts';

const views = (await import('../apps/desktop/static/shell/shell-views.js')) as unknown as {
  modelRow: (s: unknown) => [string, string];
  serverRow: (s: unknown) => [string, string];
  modelCell: (s: unknown) => string | null;
  whereRows: (run: unknown) => Array<[string, string]>;
};
const src = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('활동 기록 줄 = 실제 송신', () => {
  it('보낸 것이 없으면(오프라인·모델 판정이어도 송신 없음) 모델 "쓰지 않음", 우리 서버 "보낸 것 없음"', () => {
    for (const s of [undefined, null, [], ['모르는값'], 'gateway.decide']) {
      assert.deepEqual(views.modelRow(s), ['모델', '쓰지 않음(요청 해석은 이 PC 안 규칙)'], JSON.stringify(s));
      assert.deepEqual(views.serverRow(s), ['우리 서버', '보낸 것 없음'], JSON.stringify(s));
      assert.equal(views.modelCell(s), null);
    }
  });

  it('게이트웨이 판정을 보냈으면 "게이트웨이(마스킹한 문장)", 실행 토큰만이면 문장 없음이라고 적는다', () => {
    assert.deepEqual(views.modelRow(['gateway.run_tokens', 'gateway.decide']), ['모델', '게이트웨이를 거쳐 의도 판정 · 마스킹한 요청 문장만 보냄']);
    assert.deepEqual(views.serverRow(['gateway.run_tokens', 'gateway.decide']), ['우리 서버', '게이트웨이 · 실행 토큰 요청(문장 없음), 마스킹한 요청 문장(의도 판정)']);
    assert.equal(views.modelCell(['gateway.decide']), '게이트웨이');
    // 판정 요청 전에 실패해도(실행 토큰만 받음) 우리 서버로 간 것은 적는다. 모델은 쓰지 않았다.
    assert.deepEqual(views.serverRow(['gateway.run_tokens']), ['우리 서버', '게이트웨이 · 실행 토큰 요청(문장 없음)']);
    assert.deepEqual(views.modelRow(['gateway.run_tokens']), ['모델', '쓰지 않음(요청 해석은 이 PC 안 규칙)']);
  });

  it('시연 모델(OpenRouter)은 모델 줄에만, 우리 서버로는 보내지 않았다', () => {
    assert.deepEqual(views.modelRow(['openrouter_demo']), ['모델', 'OpenRouter(시연 예외) · 채팅 문장과 가상 거래처 이름만 보냄']);
    assert.deepEqual(views.serverRow(['openrouter_demo']), ['우리 서버', '보낸 것 없음']);
    assert.equal(views.modelCell(['openrouter_demo']), 'OpenRouter(시연)');
  });

  it('결과 카드의 "어디로 무엇이 갔나요"도 같은 줄을 쓴다', () => {
    const run = { result: { mailTo: '', mailConfirmed: false }, sent: ['gateway.decide'] };
    const rows = views.whereRows(run);
    assert.deepEqual(rows.find((r) => r[0] === '우리 서버'), ['우리 서버', '게이트웨이 · 마스킹한 요청 문장(의도 판정)']);
    assert.deepEqual(views.whereRows({ ...run, sent: [] }).find((r) => r[0] === '우리 서버'), ['우리 서버', '보낸 것 없음']);
  });

  it('게이트웨이 경로 → SentTo: 아는 경로만, 한 번씩, 순서 고정', () => {
    assert.deepEqual(sentFromGateway(['/v1/decide', '/v1/run-tokens', '/v1/decide', '/v1/slots']), ['gateway.run_tokens', 'gateway.decide']);
    assert.deepEqual(sentFromGateway([]), []);
  });

  it('GatewayAuthHost는 헤더를 실제로 내줄 때만 경로를 알린다(거부·로그인 전·실패는 알리지 않음)', async () => {
    const seen: string[] = [];
    const ok = new GatewayAuthHost({ device: () => ({ gatewayAuth: async () => ({ Authorization: 'DPoP t', DPoP: 'p' }), clearGatewayToken: () => {} }), onIssued: (p) => seen.push(p) });
    await ok.handle({ t: 'gw.auth', id: 1, htm: 'POST', htu: GATEWAY_ORIGIN + '/v1/decide' });
    await ok.handle({ t: 'gw.auth', id: 2, htm: 'GET', htu: GATEWAY_ORIGIN + '/v1/decide' });
    await ok.handle({ t: 'gw.auth', id: 3, htm: 'POST', htu: GATEWAY_ORIGIN + '/v1/slots' });
    const fail = new GatewayAuthHost({ device: () => ({ gatewayAuth: async () => Promise.reject(new Error('x')), clearGatewayToken: () => {} }), onIssued: (p) => seen.push(p) });
    await fail.handle({ t: 'gw.auth', id: 4, htm: 'POST', htu: GATEWAY_ORIGIN + '/v1/decide' });
    await new GatewayAuthHost({ device: () => null, onIssued: (p) => seen.push(p) }).handle({ t: 'gw.auth', id: 5, htm: 'POST', htu: GATEWAY_ORIGIN + '/v1/run-tokens' });
    assert.deepEqual(seen, ['/v1/decide']);
  });

  it('배선: 해석 동안 내준 헤더 → sent, 시연 모델은 부르면 sent, 렌더러 줄은 sent로만(interp로 만들지 않음)', () => {
    const app = src('apps/desktop/src/shell-app.ts');
    assert.ok(app.includes('const mark = gwSeq;') && app.includes('const sent = sentFromGateway(gwIssuedSince(mark));'));
    assert.ok(app.includes("ask ? ['openrouter_demo'] : []"));
    assert.ok(app.includes('reply.run.sent = sent;'));
    const shell = src('apps/desktop/static/shell/shell.js');
    const viewsSrc = src('apps/desktop/static/shell/shell-views.js');
    for (const s of [shell, viewsSrc]) assert.doesNotMatch(s, /modelRow\([^)]*interp\)/);
    // 고정 "보낸 것 없음" 줄은 지난 기록 견본(row.past) 한 곳뿐이다. 이번 실행 줄은 serverRow(sent)로만.
    assert.equal(viewsSrc.match(/\['우리 서버', '보낸 것 없음'\]/g), null);
    const fixed = [...shell.matchAll(/\['우리 서버', '보낸 것 없음'\]/g)];
    assert.equal(fixed.length, 1);
    assert.ok(shell.lastIndexOf('row.past', fixed[0].index) > shell.lastIndexOf('serverRow(row.g24.sent)', fixed[0].index));
    assert.ok(shell.includes('serverRow(r.sent)') && shell.includes('serverRow(row.g24.sent)'));
    assert.doesNotMatch(shell, /interp\) === 'model' \? h\('td', \{\}, 'OpenRouter/);
  });
});
