// 말풍선 반응(ADR-057): 판정(jev, chat_route_v1)이 고른 받는 방식으로 PC 대화(AgentChat)와 폰 대화(PhoneChat)가 같은 길을 가는가.
// 모델·판정은 가짜다(모의 기준). 실제 jev 판정 정확도는 tests/chat-eval/route 러너가 잰다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  CHAT_ROUTE_BUNDLE,
  PhoneChat,
  PhoneGateway,
  REACTIONS,
  REACTION_IDS,
  TurnRecorder,
  routeAck,
  routeAnswersOf,
  turnSignal,
  type PhoneChatPorts,
  type PhoneCopy,
  type PhoneRespondRequest,
  type RouteAnswer,
  type TurnEvent,
} from '@sax/chat-core';
import type { RouteStep, StepParams, StepResult } from '@sax/engine';
import { wasMinted } from '@sax/redaction';
import { AgentChat, type AgentChatPorts } from '../apps/desktop/src/agent-chat.ts';

const ch = (value: string, confidence = 0.95): RouteAnswer => ({ type: 'choice', value, confidence });
const pr = (probability: number): RouteAnswer => ({ type: 'predicate', probability });
const ANS = (mode: string, reaction: string, o: Partial<Record<string, RouteAnswer>> = {}) => ({ reply_mode: ch(mode), reaction: ch(reaction), mentions_tax_advice: pr(0.02), ...o });

describe('routeAck: 판정 답 → 받는 방식(PC와 폰이 같은 함수)', () => {
  it('문턱 넘은 reaction_only·react_then_work만 반응한다. 나머지는 answer, 반응 없음', () => {
    assert.deepEqual(routeAck(ANS('reaction_only', 'pray')), { mode: 'reaction_only', reaction: 'pray' });
    assert.deepEqual(routeAck(ANS('react_then_work', 'eyes')), { mode: 'react_then_work', reaction: 'eyes' });
    const none = { mode: 'answer', reaction: null };
    assert.deepEqual(routeAck(ANS('answer', 'pray')), none);
    assert.deepEqual(routeAck({ ...ANS('reaction_only', 'pray'), reply_mode: ch('reaction_only', 0.79) }), none);
    assert.deepEqual(routeAck(ANS('reaction_only', 'party')), none, '허용 목록 밖 이모지');
    assert.deepEqual(routeAck(ANS('reaction_only', 'unknown')), none);
    assert.deepEqual(routeAck(ANS('unknown', 'pray')), none);
    assert.deepEqual(routeAck(ANS('reaction_only', 'pray', { mentions_tax_advice: pr(0.6) })), none, '세무 판단');
    assert.deepEqual(routeAck({ reply_mode: ch('reaction_only'), reaction: ch('pray') }), none, '세무 답이 없으면 묻는 쪽');
    assert.deepEqual(routeAck(null), none);
  });

  it('허용 목록은 넷이고 번들 reaction 선택지(unknown 빼고)와 같다. 폰이 쓰는 digest는 번들 파일과 같다', () => {
    const b = JSON.parse(fs.readFileSync(new URL('../packages/model/bundles/chat_route_v1.json', import.meta.url), 'utf8')) as { digest: string; questions: Array<{ name: string; choices?: Array<{ value: string }> }>; maxInputBytes: number };
    const values = (n: string) => b.questions.find((q) => q.name === n)!.choices!.map((c) => c.value).filter((v) => v !== 'unknown');
    assert.deepEqual(values('reaction').sort(), [...REACTION_IDS].sort());
    assert.deepEqual(Object.values(REACTIONS), ['👍', '👀', '✅', '🙏']);
    assert.deepEqual(values('reply_mode'), ['reaction_only', 'react_then_work', 'answer']);
    assert.equal(CHAT_ROUTE_BUNDLE.digest, b.digest);
    assert.equal(b.maxInputBytes, 4096);
  });

  it('게이트웨이 응답 꼴(Decisions 배열)을 이름 키 답으로 옮기고 모르는 꼴은 버린다', () => {
    const a = routeAnswersOf([
      { type: 'choice', name: 'reply_mode', choice: 'reaction_only', confidence: 0.9, probabilities: [] },
      { type: 'predicate', name: 'mentions_tax_advice', probability: 0.01 },
      { type: 'choice', name: 'reaction', choice: 7, confidence: 0.9 },
      { type: 'missing', name: 'act' },
      null,
    ]);
    assert.deepEqual(a, { reply_mode: { type: 'choice', value: 'reaction_only', confidence: 0.9 }, mentions_tax_advice: { type: 'predicate', probability: 0.01 } });
    assert.deepEqual(routeAnswersOf('x'), {});
  });
});

describe('턴 이벤트와 운영 신호(ADR-054 결정 5)', () => {
  it('끝은 한 번만 나가고, 신호에는 문장·토큰·인자·ref·id·반응 대상이 없다', () => {
    let t = 100;
    const seen: TurnEvent[] = [];
    const r = new TurnRecorder('01TURN', () => (t += 10), (e) => seen.push(e));
    r.emit({ type: 'turn.start', device: 'phone', msgId: '01MSG' });
    r.emit({ type: 'route', act: 'smalltalk', domain: 'none', mode: 'reaction_only', band: 'gte90', unsure: false, failed: false });
    r.emit({ type: 'reaction', msgId: '01MSG', reaction: 'pray' });
    r.emit({ type: 'tool.start', tool: 'invoice_draft', args: { counterparty: '[NAME_1]' } });
    r.emit({ type: 'tool.end', tool: 'invoice_draft', status: 'card_shown', ref: 'd1', runId: null });
    r.emit({ type: 'turn.end', status: 'completed' });
    r.emit({ type: 'turn.end', status: 'failed' });
    assert.deepEqual(seen.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
    assert.ok(r.done);
    const sig = turnSignal(seen);
    assert.deepEqual(sig, { device: 'phone', mode: 'reaction_only', band: 'gte90', unsure: false, routeFailed: false, reaction: 'pray', path: null, tools: ['invoice_draft'], statuses: ['card_shown'], recall: false, filtered: null, end: 'completed', code: null, ms: 50 });
    const flat = JSON.stringify(sig);
    for (const leak of ['01TURN', '01MSG', 'NAME_1', 'd1']) assert.ok(!flat.includes(leak), leak);
  });
});

// ── PC: AgentChat ──

const pcReply = (text: string): StepResult => ({ kind: 'reply', reply: { kind: 'answer', text, show: [], ask: null, filtered: null, values: {}, unknownName: null } });
const step = (mode: RouteStep['mode'], reaction: RouteStep['reaction']): RouteStep => ({ kind: 'route', mode, reaction, act: null, domain: null, band: 'gte90', unsure: false, failed: false });

function pc(route: (() => Promise<RouteStep>) | null, steps: Array<() => StepResult>) {
  const log: string[] = [];
  const events: TurnEvent[] = [];
  const ports: AgentChatPorts = {
    step: async (p: StepParams) => (log.push(`step:${'start' in p ? 'start' : 'continue'}`), steps.shift()!()),
    ...(route ? { route: async () => (log.push('route'), route()) } : {}),
    onReaction: (r) => log.push(`reaction:${r}`),
    onEvent: (e) => events.push(e),
    profileId: () => 'pf1',
    drafts: { list: () => [], setupMissing: () => false, create: () => ({ runId: 'x' }), update: () => {}, discard: () => {} },
    issued: () => [],
    receivables: async () => null,
    counterparties: () => [],
    today: () => '2026-11-19',
    onProgress: (p) => log.push(`progress:${p}`),
    now: () => 1_000,
  };
  return { chat: new AgentChat(ports), log, events };
}

describe('PC 대화(AgentChat): 판정 → 반응 → 도구', () => {
  it('반응만: chat.step을 부르지 않고 반응 하나로 닫는다', async () => {
    const t = pc(async () => step('reaction_only', 'pray'), []);
    assert.deepEqual(await t.chat.turn('고마워'), { kind: 'reaction', reaction: 'pray' });
    assert.deepEqual(t.log, ['progress:thinking', 'route', 'reaction:pray']);
    assert.deepEqual(t.events.map((e) => e.type), ['turn.start', 'route', 'reaction', 'path', 'turn.end']);
    assert.equal(turnSignal(t.events).path, 'reaction');
  });

  it('일 맡기기: 반응이 답보다 먼저 오고, 답은 도구 루프가 낸다', async () => {
    const t = pc(async () => step('react_then_work', 'eyes'), [() => pcReply('카드를 만들었어요.')]);
    const r = await t.chat.turn('A상사 55만원 끊어줘');
    assert.equal(r.kind, 'agent');
    assert.deepEqual(t.log, ['progress:thinking', 'route', 'reaction:eyes', 'step:start']);
  });

  it('판정이 answer이거나 실패하면 반응 없이 늘 하던 대로 돈다. 판정 포트가 없어도 같다', async () => {
    for (const route of [async () => step('answer', null), async (): Promise<RouteStep> => Promise.reject(new Error('chat.unavailable')), null]) {
      const t = pc(route, [() => pcReply('네.')]);
      assert.equal((await t.chat.turn('고마워 근데 매출은?')).kind, 'agent');
      assert.ok(!t.log.some((x) => x.startsWith('reaction:')));
      assert.ok(t.log.includes('step:start'));
    }
  });

  it('판정이 비밀 모양을 막으면 chat.step도 부르지 않는다', async () => {
    const t = pc(async () => Promise.reject(Object.assign(new Error('chat.secret_rejected'), { code: 'chat.secret_rejected' })), []);
    const r = await t.chat.turn('비번 qwer1234!@');
    assert.deepEqual([r.kind, r.kind === 'unavailable' && r.code], ['unavailable', 'chat.secret_rejected']);
    assert.ok(!t.log.includes('step:start'));
    assert.equal(turnSignal(t.events).end, 'failed');
  });
});

// ── 폰: PhoneChat ──

const T0 = Date.UTC(2026, 10, 19, 3, 0);
const COPY: PhoneCopy = { asOf: T0 - 3600_000, profile: { id: 'p1', name: '율무상회', repName: '김율무', bizNo: '123-45-67890' }, counterparties: [{ id: 'c1', name: '한빛전자', item: '컨설팅' }], issued: [], receivables: [] };

function phone(first: Record<string, RouteAnswer> | null | 'throw') {
  let answers = first;
  let id = 0;
  let saved: string | null = null;
  const reqs: PhoneRespondRequest[] = [];
  const routed: string[] = [];
  const log: string[] = [];
  const ports: PhoneChatPorts = {
    model: {
      runToken: async () => 'rt-0123456789abcdef',
      respond: async (req) => {
        reqs.push(req);
        return { status: 'completed', output: { kind: 'answer', text: '카드를 만들었어요.', show: [], ask: null }, toolCalls: [], replay: [{ item: { type: 'message', content: [] }, tag: '0'.repeat(64) }] };
      },
      route: async (req) => {
        assert.ok(wasMinted(req.text));
        routed.push(req.text);
        if (answers === 'throw') throw new Error('x');
        return answers;
      },
    },
    store: { load: async () => saved, save: async (d) => void (saved = d) },
    copy: () => COPY,
    now: () => T0,
    newId: () => `01KA${String(++id).padStart(22, '0')}`,
    randomHex: () => '0'.repeat(32),
    onReaction: (r) => log.push(`reaction:${r}`),
  };
  return { chat: new PhoneChat(ports), reqs, routed, log, saved: () => saved, set: (a: typeof first) => void (answers = a) };
}

describe('폰 대화(PhoneChat): PC와 같은 판정 → 반응', () => {
  it('실제 PhoneGateway(클래스)로 /v1/decide를 부르고 판정 답으로 반응만 닫는다', async () => {
    const paths: string[] = [];
    const gw = new PhoneGateway({
      origin: 'https://tax.example',
      authHeaders: async () => ({ Authorization: 'DPoP t', DPoP: 'p' }),
      fetch: async (url, init) => {
        const path = url.slice('https://tax.example'.length);
        paths.push(path);
        const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        const out =
          path === '/v1/run-tokens'
            ? { runToken: `rt_${'x'.repeat(30)}` }
            : path === '/v1/decide'
              ? (assert.equal(body.bundleId, CHAT_ROUTE_BUNDLE.id), assert.equal(body.bundleDigest, CHAT_ROUTE_BUNDLE.digest), { answers: [{ type: 'choice', name: 'reply_mode', choice: 'reaction_only', confidence: 0.95 }, { type: 'choice', name: 'reaction', choice: 'pray', confidence: 0.95 }, { type: 'predicate', name: 'mentions_tax_advice', probability: 0.01 }] })
              : { status: 'completed', output: [] };
        return { status: 200, text: async () => JSON.stringify(out) };
      },
    });
    let id = 0;
    let saved: string | null = null;
    const chat = new PhoneChat({ model: gw, store: { load: async () => saved, save: async (d) => void (saved = d) }, copy: () => COPY, now: () => T0, newId: () => `01KB${String(++id).padStart(22, '0')}`, randomHex: () => '0'.repeat(32) });
    const r = await chat.send('고마워');
    assert.deepEqual([r.kind, r.kind === 'reaction' && r.reaction], ['reaction', 'pray']);
    assert.deepEqual(paths, ['/v1/run-tokens', '/v1/decide']);
  });

  it('반응만: 대화 모델을 부르지 않고, 사용자 말에 반응을 붙여 남긴다. 판정 입력에 원값이 없다', async () => {
    const t = phone(ANS('reaction_only', 'thumbs_up'));
    const r = await t.chat.send('한빛전자 건 확인했어');
    assert.equal(r.kind, 'reaction');
    assert.equal(t.reqs.length, 0);
    assert.deepEqual(t.log, ['reaction:thumbs_up']);
    assert.match(t.routed[0]!, /^기기: 폰\n/);
    assert.match(t.routed[0]!, /사용자: \[NAME_\d+\] 건 확인했어$/);
    assert.ok(!t.routed[0]!.includes('한빛전자'));
    const log = await t.chat.messages();
    assert.deepEqual(log.map((m) => [m.from, m.reaction ?? null]), [['user', 'thumbs_up']]);
    assert.equal(r.kind === 'reaction' && r.id, log[0]!.id);
    // 다음 턴 [앞 대화]에 반응 줄이 있다(모델이 그 말에 답하지 않은 것을 안다)
    t.set(ANS('answer', 'eyes'));
    await t.chat.send('이번 달 받을 돈 얼마야');
    assert.match(String(t.reqs.at(-1)!.text), /사용자: \[NAME_\d+\] 건 확인했어\n앱: \(반응 👍\)/);
  });

  it('일 맡기기: 반응이 먼저 오고 답은 모델이 낸다. 결과에 사용자 메시지 id와 반응이 있다', async () => {
    const t = phone(ANS('react_then_work', 'eyes'));
    const r = await t.chat.send('한빛전자 받을 돈 얼마야');
    assert.equal(r.kind, 'reply');
    assert.deepEqual(t.log, ['reaction:eyes']);
    assert.equal(t.reqs.length, 1);
    const log = await t.chat.messages();
    assert.deepEqual(log.map((m) => [m.from, m.reaction ?? null]), [['user', 'eyes'], ['app', null]]);
    assert.deepEqual(r.kind === 'reply' && r.user, { id: log[0]!.id, reaction: 'eyes' });
  });

  it('판정이 없거나 실패하거나 answer면 반응 없이 늘 하던 대로 답한다', async () => {
    for (const a of [null, 'throw' as const, ANS('answer', 'pray')]) {
      const t = phone(a);
      const r = await t.chat.send('고마워 근데 받을 돈은?');
      assert.equal(r.kind, 'reply');
      assert.deepEqual(t.log, []);
      assert.equal(t.reqs.length, 1);
    }
  });
});
