// 결정 모델 칸 고르기 평가(위치 찾기 첫 호출 decision_pick): 가짜 홈택스 작성 화면의 실제 textbox 목록(55개, form-textboxes.json)에서
// 목표 칸 번호를 고르게 한다. 제품과 같은 글(decisionPickInput)·같은 지시문(DECISION_PICK 접두)으로 OpenRouter decisions를 직접 부른다.
//   node --conditions=development tests/ladder-live/pick-eval.ts --models=typesafe/jev-1.14 --reps=2 [--cases=A,B] [--shapes=full+none,short+none,full,short]
// 모양(--shapes): full/short = id 그대로/공통 머리 생략, +none = '없음' 선택지. none이 없으면 p 문턱으로 '모름'을 낸다(요약에 문턱별 정답 수).
// 키: OPENROUTER_API_KEY(환경 변수로만). 결과: 경우·모델마다 고른 번호·정답 여부·p·confidence·시간·비용.
import fs from "node:fs";
import {
  DECISION_PICK,
  toolsetPrefix,
} from "../../packages/model/src/index.ts";
import { apply } from "../../packages/redaction/src/index.ts";
import {
  decisionPickInput,
  type DecisionPickShape,
} from "../../packages/engine/src/run/locate-port.ts";
import type { LocateRequest } from "../../packages/engine/src/core/locate.ts";

const arg = (k: string, d = "") =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const models = arg("models", "cloudflare/clef-flash")
  .split(",")
  .filter(Boolean);
const reps = Number(arg("reps", "1"));
const only = new Set(arg("cases").split(",").filter(Boolean));
const max = Number(arg("max", "0"));
const shapes = arg("shapes", "full+none")
  .split(",")
  .filter(Boolean)
  .map((x) => ({
    label: x,
    shape: {
      ids: x.startsWith("short") ? "short" : "full",
      none: x.endsWith("+none"),
    } as DecisionPickShape,
  }));
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY 없음");
const rows = JSON.parse(
  fs.readFileSync(new URL("./form-textboxes.json", import.meta.url), "utf8"),
) as Array<{ n: number; name: string; id: string | null }>;
const P = "mf_txppWframe_";

interface Case {
  id: string;
  key: string;
  was: string[];
  expect: string;
  drop?: number[];
  why: string;
}
const CASES: Case[] = [
  {
    id: "A",
    key: "hometax.invoice.form.item1.name",
    was: [`#${P}genEtxivLsatTop_0_edtLsatNmTopOld`],
    expect: "22",
    why: "1행 품목(이름 없음, id만 단서)",
  },
  {
    id: "B",
    key: "hometax.invoice.form.item1.supply",
    was: [`#${P}genEtxivLsatTop_0_edtLsatSplCftTopOld`],
    expect: "26",
    why: "1행 공급가액(이름 없음)",
  },
  {
    id: "C",
    key: "hometax.invoice.form.counterpartBizNo",
    was: [`#${P}edtDmnrBsnoTopOld`],
    expect: "8",
    why: "공급받는자 등록번호(이름 없음)",
  },
  {
    id: "D",
    key: "hometax.invoice.form.counterpartName",
    was: [`#${P}edtDmnrTnmNmTopOld`],
    expect: "9",
    why: "공급받는자 상호(이름 없음)",
  },
  {
    id: "E",
    key: "hometax.invoice.form.item1.name",
    was: [],
    expect: "22",
    why: "예전 선택자 단서 없이 1행 품목",
  },
  {
    id: "F",
    key: "hometax.invoice.form.item1.name",
    was: [`#${P}genEtxivLsatTop_0_edtLsatNmTopOld`],
    expect: "none",
    drop: [22],
    why: "목표 칸이 목록에 없음 → none",
  },
];

const mask = (t: string) =>
  apply(t, { runId: "pick-eval" }, { frame: "none" }).redacted as string;
const prefix = toolsetPrefix(DECISION_PICK);
// none이 없는 모양은 지시문에서 none 문장을 '가장 가까운 번호'로 바꾼다(제품 지시문은 바꾸지 않는다)
const prefixNoNone = prefix.replace(
  "목표 칸이 목록에 없거나 확신이 없으면 none을 고른다.",
  "목표 칸에 가장 가까운 번호 하나를 고른다.",
);
const out: Array<Record<string, unknown>> = [];
for (const c of CASES.filter((x) => !only.size || only.has(x.id))) {
  let listing = rows.filter((r) => !c.drop?.includes(r.n));
  if (max) listing = listing.slice(0, max);
  const req: LocateRequest = {
    stepId: "s16a",
    key: c.key,
    purpose: "fill",
    role: "textbox",
    namePattern: "^.{0,60}$",
    describe: `${c.key} · text`,
    listing,
    rejected: [],
    was: c.was,
  };
  for (const { label, shape } of shapes) {
    const built = decisionPickInput(req, shape);
    // 평가는 선택지 상한(DECISION_MAX_CHOICES)을 넘어도 보내 본다: 모델 쪽 한도를 재려고
    const pool = typeof built === "string" ? listing : built.pool;
    const input =
      typeof built === "string"
        ? null
        : (JSON.parse(mask(built.json)) as {
            state: string;
            choices: Record<string, string>;
          });
    const state =
      input?.state ??
      mask(
        `[목표] 스텝 s16a: fill · 항목 ${req.describe} · 역할 textbox\n예전 선택자(지금은 못 찾음): ${c.was.join(", ")}\n선택지는 아래 같은 역할 요소 목록의 번호다. 목표 칸이 없거나 확신이 없으면 none.`,
      );
    const choices =
      input?.choices ??
      Object.fromEntries([
        ...pool.map((x) => [
          String(x.n),
          mask(`textbox "${x.name}"${x.id ? ` #${x.id}` : ""}`),
        ]),
        ["none", "목록에 목표 칸이 없다 또는 확신이 없다"],
      ]);
    if (!input) console.log(`  ${c.id}/${label}: 상한 초과로 평가용 글을 썼다`);
    for (const model of models) {
      for (let r = 0; r < reps; r++) {
        const t0 = Date.now();
        const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            state,
            questions: {
              pick: {
                type: "choice",
                instructions: shape.none ? prefix : prefixNoNone,
                criteria: choices,
              },
            },
            provider: { data_collection: "deny" },
          }),
        });
        const ms = Date.now() - t0;
        const body = await res.text();
        let d: {
          answers?: {
            pick?: {
              choice?: string;
              confidence?: number;
              probabilities?: Record<string, number>;
            };
          };
          usage?: { input_tokens?: number; cost?: number };
          provider?: string;
        } = {};
        try {
          d = JSON.parse(body);
        } catch {
          /* 오류 본문 */
        }
        const a = d.answers?.pick;
        const probs = Object.entries(a?.probabilities ?? {})
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([k, v]) => `${k}:${v.toFixed(2)}`)
          .join(" ");
        const row = {
          case: c.id,
          why: c.why,
          shape: label,
          expect: c.expect,
          top3: probs,
          model,
          rep: r + 1,
          status: res.status,
          choices: Object.keys(choices).length,
          choice: a?.choice ?? null,
          ok: a?.choice === c.expect,
          p: a?.choice ? (a.probabilities?.[a.choice] ?? null) : null,
          confidence: a?.confidence ?? null,
          expectP: a?.probabilities?.[c.expect] ?? null,
          ms,
          inputTokens: d.usage?.input_tokens ?? null,
          cost: d.usage?.cost ?? null,
          provider: d.provider ?? null,
          ...(res.status !== 200 ? { error: body.slice(0, 300) } : {}),
        };
        out.push(row);
        console.log(
          `${c.id} ${label} ${model} #${r + 1}: [${probs}] ${res.status} 고름 ${row.choice} (정답 ${c.expect}) ${row.ok ? "O" : "X"} p=${row.p} conf=${row.confidence} 정답p=${row.expectP} ${ms}ms in=${row.inputTokens} $${row.cost} ${row.provider ?? ""}${res.status !== 200 ? ` ${body.slice(0, 200)}` : ""}`,
        );
      }
    }
  }
}
// 문턱 t: 고른 번호의 p가 t 미만이면 '모름(none)'으로 본다. 정답이 none인 경우(F)는 모름이 맞다.
const at = (x: Record<string, unknown>, t: number) =>
  (x.choice !== "none" && Number(x.p) >= t ? x.choice : "none") === x.expect;
for (const model of models)
  for (const { label } of shapes) {
    const xs = out.filter(
      (x) => x.model === model && x.shape === label && x.status === 200,
    );
    const cost = xs.reduce((s, x) => s + Number(x.cost ?? 0), 0);
    const ts = [0, 0.2, 0.3, 0.4, 0.5]
      .map((t) => `t${t}=${xs.filter((x) => at(x, t)).length}`)
      .join(" ");
    console.log(
      `요약 ${model} ${label}: 정답 ${xs.filter((x) => x.ok).length}/${xs.length} · 문턱별 ${ts} · 중간 ${xs.map((x) => Number(x.ms)).sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? "-"}ms · 입력 ${xs[0]?.inputTokens ?? "-"}토큰 · 합계 $${cost.toFixed(6)}`,
    );
  }
const file = arg("out");
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2));
