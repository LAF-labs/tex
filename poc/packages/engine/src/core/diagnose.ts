// 핸드오프 진단(부장 2026-11-13, 실화면 예행 run-ff36aa3e s12 identity_mismatch 원인 찾기):
// identity_mismatch·selector_miss로 사람에게 넘길 때 그 대상 항목이 실제 화면에서 어떻게 보이는지 engine.log에 한 줄로 남긴다.
// - 담는 것: 랜드마크 해석 결과, 후보마다 맞은 요소(태그·id·역할·접근성 이름·label·title·type·readonly·disabled·보임)와
//   R-A1이 본 역할·이름·판정, 랜드마크 영역(없으면 프레임)의 입력·단추·label 모양, 프레임 이름.
// - 담지 않는 것: 입력값(읽지 않는다), 비밀 칸(비밀번호·가림 글 칸은 통째로 뺀다). 화면 글의 숫자는 모두 #로 가린다(금액·번호).
//   패키지 쪽 글(후보 선택자·이름 규칙)은 그대로 둔다. 로그 쪽(platform diagSafe)이 한 번 더 거른다.
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

export interface TargetDiagnosis {
  key: string;
  frame: string;
  role: string;
  namePattern: string;
  expect: string;
  frames: string[];
  landmark: { key: string; ok: boolean; code: string | null } | null;
  candidates: Array<{
    candidate: string;
    hits: Array<Shape & { aria: { role: string; name: string }; identity: 'ok' | 'role' | 'name' }>;
    /** 랜드마크 밖(프레임 전체)에서 맞은 수. 랜드마크 안에서 0일 때만 센다. */
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
  const candidates: TargetDiagnosis['candidates'] = [];
  for (const c of entry.candidates.slice(0, 8)) {
    const els = await page.query(c, entry.frame, within);
    const hits: TargetDiagnosis['candidates'][number]['hits'] = [];
    for (const el of els.slice(0, HITS_PER_CANDIDATE)) {
      const shape = await page.describe(el);
      if (!shape || shape.secret) continue;
      const info = await page.info(el);
      hits.push({ ...masked(shape), aria: { role: info.role, name: maskScreenText(info.name) }, identity: identityProblem(entry, info) ?? 'ok' });
    }
    const outsideLandmark = within && !els.length ? (await page.query(c, entry.frame, null)).length : null;
    candidates.push({ candidate: candidateText(c), hits, outsideLandmark });
  }
  const all = await page.describeRegion(entry.frame, within, REGION_MAX);
  return {
    key, frame: entry.frame, role: entry.role, namePattern: entry.namePattern,
    expect: Object.entries(entry.expect ?? {}).filter(([, v]) => v).map(([k]) => k).join(','),
    frames: page.frameNames?.() ?? [],
    landmark, candidates,
    region: all.filter((x) => !x.secret).map(masked),
    regionSecretDropped: all.filter((x) => x.secret).length,
  };
}
