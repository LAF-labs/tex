import { maskScreenText } from './constants.ts';
import { candidateText } from './locate.ts';
import type { ElementShape, PageReader } from './page.ts';
import { identityProblem, resolveTarget } from './resolve.ts';
import type { SelectorDict } from './types.ts';

const HITS_PER_CANDIDATE = 5;
const REGION_MAX = 60;


type Shape = Omit<ElementShape, 'secret'>;
const masked = (x: ElementShape): Shape => ({
  tag: x.tag, id: x.id, role: x.role, name: maskScreenText(x.name), label: maskScreenText(x.label), title: maskScreenText(x.title),
  type: x.type, readonly: x.readonly, disabled: x.disabled, visible: x.visible,
});

interface TargetDiagnosis {
  key: string;
  frame: string;
  role: string;
  namePattern: string;
  expect: string;
  frames: string[];
  landmark: { key: string; ok: boolean; code: string | null } | null;
  landmarkChain: Array<{ key: string; ok: boolean; code: string | null; candidate: string; tag: string | null; id: string | null; aria: { role: string; name: string } | null; namePattern: string; role: string }>;
  candidates: Array<{
    candidate: string;
    hits: Array<Shape & { aria: { role: string; name: string }; identity: 'ok' | 'role' | 'name'; editable: boolean | null }>;
    outsideLandmark: number | null;
  }>;
  region: Shape[];
  regionSecretDropped: number;
}

/** 대상 항목의 실제 화면 모양. 읽기만 한다. 구현이 없거나 비밀 칸 항목이면 null. */
export async function targetDiagnosis(page: PageReader, dict: SelectorDict, key: string): Promise<TargetDiagnosis | null> {
  const entry = dict.entries[key];
  if (!entry || !page.describe || !page.describeRegion || entry.secretKind || entry.inputType === 'password') return null;
  let within = null;
  let landmark: TargetDiagnosis['landmark'] = null;
  if (entry.landmark !== key) {
    const lm = await resolveTarget(page, dict, entry.landmark);
    landmark = { key: entry.landmark, ok: lm.ok, code: lm.ok ? null : lm.code };
    within = lm.ok ? lm.t.el : null;
  }
  const landmarkChain: TargetDiagnosis['landmarkChain'] = [];
  for (let k = entry.landmark, seen = new Set<string>([key]); !seen.has(k) && landmarkChain.length < 6; ) {
    seen.add(k);
    const e = dict.entries[k];
    if (!e) {
      landmarkChain.push({ key: k, ok: false, code: 'no_entry', candidate: '', tag: null, id: null, aria: null, namePattern: '', role: '' });
      break;
    }
    const r = await resolveTarget(page, dict, k);
    const shape = r.ok ? await page.describe(r.t.el) : null;
    const info = r.ok ? await page.info(r.t.el) : null;
    landmarkChain.push({
      key: k, ok: r.ok, code: r.ok ? null : r.code, candidate: e.candidates[0] ? candidateText(e.candidates[0]) : '',
      tag: shape?.tag ?? null, id: shape?.id ?? null, aria: info ? { role: info.role, name: maskScreenText(info.name) } : null, namePattern: e.namePattern, role: e.role,
    });
    if (e.landmark === k) break;
    k = e.landmark;
  }
  const candidates: TargetDiagnosis['candidates'] = [];
  for (const c of entry.candidates.slice(0, 8)) {
    const els = await page.query(c, entry.frame, within);
    const hits: TargetDiagnosis['candidates'][number]['hits'] = [];
    for (const el of els.slice(0, HITS_PER_CANDIDATE)) {
      const shape = await page.describe(el);
      if (!shape || shape.secret) continue;
      const info = await page.info(el);
      hits.push({ ...masked(shape), aria: { role: info.role, name: maskScreenText(info.name) }, identity: identityProblem(entry, info) ?? 'ok', editable: info.editable ?? null });
    }
    const outsideLandmark = within && !els.length ? (await page.query(c, entry.frame, null)).length : null;
    candidates.push({ candidate: candidateText(c), hits, outsideLandmark });
  }
  const all = await page.describeRegion(entry.frame, within, REGION_MAX);
  return {
    key, frame: entry.frame, role: entry.role, namePattern: entry.namePattern,
    expect: Object.entries(entry.expect ?? {}).filter(([, v]) => v).map(([k]) => k).join(','),
    frames: page.frameNames?.() ?? [],
    landmark, landmarkChain, candidates,
    region: all.filter((x) => !x.secret).map(masked),
    regionSecretDropped: all.filter((x) => x.secret).length,
  };
}
