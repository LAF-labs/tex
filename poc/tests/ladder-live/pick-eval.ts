import fs from 'node:fs';
import { DECISION_PICK, toolsetPrefix } from '../../packages/model/src/index.ts';
import { apply } from '../../packages/redaction/src/index.ts';
import { decisionPickInput, type DecisionPickShape } from '../../packages/engine/src/run/locate-port.ts';
import type { LocateRequest } from '../../packages/engine/src/core/locate.ts';

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const models = arg('models', '~typesafe/jev-latest').split(',').filter(Boolean);
const reps = Number(arg('reps', '1'));
const only = new Set(arg('cases').split(',').filter(Boolean));
const max = Number(arg('max', '0'));
const shapes = arg('shapes', 'short').split(',').filter(Boolean).map((x) => ({ label: x, shape: { ids: x.startsWith('short') ? 'short' : 'full', none: x.endsWith('+none') } as DecisionPickShape }));
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY 없음');
const rows = JSON.parse(fs.readFileSync(new URL('./form-textboxes.json', import.meta.url), 'utf8')) as Array<{ n: number; name: string; id: string | null }>;
const P = 'mf_txppWframe_';

interface Case { id: string; key: string; was: string[]; expect: string; drop?: number[]; why: string }
const CASES: Case[] = [
  { id: 'A', key: 'hometax.invoice.form.item1.name', was: [`#${P}genEtxivLsatTop_0_edtLsatNmTopOld`], expect: '22', why: '1행 품목(이름 없음, id만 단서)' },
  { id: 'B', key: 'hometax.invoice.form.item1.supply', was: [`#${P}genEtxivLsatTop_0_edtLsatSplCftTopOld`], expect: '26', why: '1행 공급가액(이름 없음)' },
  { id: 'C', key: 'hometax.invoice.form.counterpartBizNo', was: [`#${P}edtDmnrBsnoTopOld`], expect: '8', why: '공급받는자 등록번호(이름 없음)' },
  { id: 'D', key: 'hometax.invoice.form.counterpartName', was: [`#${P}edtDmnrTnmNmTopOld`], expect: '9', why: '공급받는자 상호(이름 없음)' },
  { id: 'E', key: 'hometax.invoice.form.item1.name', was: [], expect: '22', why: '예전 선택자 단서 없이 1행 품목' },
  { id: 'F', key: 'hometax.invoice.form.item1.name', was: [`#${P}genEtxivLsatTop_0_edtLsatNmTopOld`], expect: 'none', drop: [22], why: '목표 칸이 목록에 없음 → none' },
  { id: 'G', key: 'hometax.invoice.form.item1.tax', was: [`#${P}genEtxivLsatTop_0_edtLsatTxamtTopOld`], expect: '27', why: '1행 세액(이름 없음)' },
  { id: 'H', key: 'hometax.invoice.form.supplierName', was: [`#${P}edtSplrTnmNmTopOld`], expect: '1', why: '공급자 상호(이름 없음, 공급받는자 9와 비슷)' },
  { id: 'I', key: 'hometax.invoice.form.remark', was: [`#${P}edtRmrkCntnTopOld`], expect: '19', why: '비고(이름 없음, 행 비고와 비슷)' },
  { id: 'J', key: 'hometax.invoice.form.item1.supply', was: [`#${P}genEtxivLsatTop_0_edtLsatSplCftTopOld`], expect: 'none', drop: [26], why: '1행 공급가액이 빠짐(2행 공급가액 35가 비슷) → none' },
  { id: 'K', key: 'hometax.invoice.form.counterpartBizNo', was: [`#${P}edtDmnrBsnoTopOld`], expect: 'none', drop: [8], why: '공급받는자 등록번호가 빠짐 → none' },
  { id: 'L', key: 'hometax.invoice.form.counterpartName', was: [], expect: '9', why: '예전 선택자 단서 없이 공급받는자 상호' },
];

const mask = (t: string) => apply(t, { runId: 'pick-eval' }, { frame: 'none' }).redacted as string;
const prefix = toolsetPrefix(DECISION_PICK);
const prefixNone = prefix.replace('목표 칸에 가장 가까운 번호 하나를 고른다(확신 정도는 확률로 낸다).', '목표 칸이 목록에 없거나 확신이 없으면 none을 고른다.');
const out: Array<Record<string, unknown>> = [];
for (const c of CASES.filter((x) => !only.size || only.has(x.id))) {
  let listing = rows.filter((r) => !c.drop?.includes(r.n));
  if (max) listing = listing.slice(0, max);
  const req: LocateRequest = { stepId: 's16a', key: c.key, purpose: 'fill', role: 'textbox', namePattern: '^.{0,60}$', describe: `${c.key} · text`, listing, rejected: [], was: c.was };
  for (const { label, shape } of shapes) {
  const built = decisionPickInput(req, shape);
  const pool = typeof built === 'string' ? listing : built.pool;
  const input = typeof built === 'string' ? null : (JSON.parse(mask(built.json)) as { state: string; choices: Record<string, string> });
  const state = input?.state ?? mask(`[목표] 스텝 s16a: fill · 항목 ${req.describe} · 역할 textbox\n예전 선택자(지금은 못 찾음): ${c.was.join(', ')}\n선택지는 아래 같은 역할 요소 목록의 번호다. 목표 칸이 없거나 확신이 없으면 none.`);
  const choices = input?.choices ?? Object.fromEntries([...pool.map((x) => [String(x.n), mask(`textbox "${x.name}"${x.id ? ` #${x.id}` : ''}`)]), ['none', '목록에 목표 칸이 없다 또는 확신이 없다']]);
  if (!input) console.log(`  ${c.id}/${label}: 상한 초과로 평가용 글을 썼다`);
  for (const model of models) {
    for (let r = 0; r < reps; r++) {
      const t0 = Date.now();
      const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions: { pick: { type: 'choice', instructions: shape.none ? prefixNone : prefix, criteria: choices } }, provider: { data_collection: 'deny' } }),
      });
      const ms = Date.now() - t0;
      const body = await res.text();
      let d: { answers?: { pick?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } }; usage?: { input_tokens?: number; cost?: number }; provider?: string; model?: string } = {};
      try {
        d = JSON.parse(body);
      } catch {
        /* 오류 본문 */
      }
      const a = d.answers?.pick;
      const probs = Object.entries(a?.probabilities ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ');
      const row = { case: c.id, why: c.why, shape: label, expect: c.expect, top3: probs, model, rep: r + 1, status: res.status, choices: Object.keys(choices).length, choice: a?.choice ?? null, ok: a?.choice === c.expect, p: a?.choice ? (a.probabilities?.[a.choice] ?? null) : null, confidence: a?.confidence ?? null, expectP: a?.probabilities?.[c.expect] ?? null, ms, inputTokens: d.usage?.input_tokens ?? null, cost: d.usage?.cost ?? null, provider: d.provider ?? null, resolved: d.model ?? null, ...(res.status !== 200 ? { error: body.slice(0, 300) } : {}) };
      out.push(row);
      console.log(`${c.id} ${label} ${model} #${r + 1}: [${probs}] ${res.status} 고름 ${row.choice} (정답 ${c.expect}) ${row.ok ? 'O' : 'X'} p=${row.p} conf=${row.confidence} 정답p=${row.expectP} ${ms}ms in=${row.inputTokens} $${row.cost} ${row.provider ?? ''} ${row.resolved ?? ''}${res.status !== 200 ? ` ${body.slice(0, 200)}` : ''}`);
    }
  }
  }
}
const wrong = (x: Record<string, unknown>, t: number) => x.choice !== 'none' && Number(x.p) >= t && x.choice !== x.expect;
const at = (x: Record<string, unknown>, t: number) => (x.choice !== 'none' && Number(x.p) >= t ? x.choice : 'none') === x.expect;
for (const model of models)
  for (const { label } of shapes) {
    const xs = out.filter((x) => x.model === model && x.shape === label && x.status === 200);
    const cost = xs.reduce((s, x) => s + Number(x.cost ?? 0), 0);
    const ts = [0, 0.5, 0.6, 0.7, 0.8].map((t) => `t${t}=${xs.filter((x) => at(x, t)).length}(오답${xs.filter((x) => wrong(x, t)).length})`).join(' ');
    console.log(`요약 ${model} ${label}: 정답 ${xs.filter((x) => x.ok).length}/${xs.length} · 문턱별 ${ts} · 중간 ${xs.map((x) => Number(x.ms)).sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? '-'}ms · 입력 ${xs[0]?.inputTokens ?? '-'}토큰 · 합계 $${cost.toFixed(6)}`);
  }
const file = arg('out');
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2));
