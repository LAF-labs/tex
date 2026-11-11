// 홈택스 민원증명(H-03·H-04·H-08·H-09) 실행 입력(D03 §2 실행 시작, 승인 카드 cert.confirm). RunService.startCert가 쓴다.
// - 입력 검사는 서명 패키지의 playbook.inputs 선언(필수·enum 값·기본값)을 그대로 따른다. 서류마다 다른 칸(H-08 과세기간, H-09 귀속연도 등)도
//   패키지가 선언한 것만 받는다. 선언에 없는 키·선언 밖 값·빠진 필수 칸은 브라우저를 열기 전에 거절한다(H-01 입력 검사와 같은 엄격함).
// - 거절 코드는 데스크톱이 사람 말로 옮긴다(코드만, 값 없음). 어느 칸인지는 입력 이름(패키지 선언 키)만 엔진 로그에 남긴다.
// - 업무 키(중복 경고 $dup.businessKey)는 서류·입력·발급일(KST)·신청 사업자로 만든다. 같은 날 같은 서류를 같은 용도로 두 번 떼려 하면 카드가 알린다.
import { createHash } from 'node:crypto';
import type { InputDecl } from './core/types.ts';
import { jcs } from './gate.ts';

/** 민원증명 승인 카드 id(GATE_CARDS). */
export const CERT_CARD = 'cert.confirm';

/** main → 엔진 run.startCert 인자. inputs 키는 그 패키지 playbook.inputs 선언 키다(예: purpose·submitTo·rrnDisclosure). */
export interface CertStartParams {
  runId: string;
  /** 플레이북 id(hometax.cert.biz_registration·taxpayment·vat_tax_base·financial_statements). */
  playbookId: string;
  inputs?: Record<string, unknown>;
}

/** 입력 거절 코드(RunEnd failed). */
/** 빠진 필수 칸은 H-01과 같은 input.missing(데스크톱 문구 있음). 선언 밖 값·키는 데스크톱이 카드 선택지만 보내면 생기지 않는 오류다. */
export type CertInputCode = 'input.missing' | 'cert.input_invalid' | 'cert.input_unknown';

export type CertInputResult = { ok: true; inputs: Record<string, string> } | { ok: false; code: CertInputCode; field: string };

/** 한 칸 값 상한(홈택스 선택지·연도 문구는 이보다 짧다). */
const MAX_LEN = 100;
// 제어 문자·양방향 제어·제로폭(카드에 보이는 값과 화면 값이 갈리지 않게, 승인 바 UNSAFE_CHARS와 같은 뜻)
// eslint-disable-next-line no-control-regex -- 제어 문자를 거르는 것이 목적이다
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 민원증명 입력으로 받는 선언 종류. 그 밖(counterparty·amounts·secret_ref 등)이 선언된 패키지는 이 경로로 돌리지 않는다. */
const SCALAR = new Set<InputDecl['type']>(['enum', 'string', 'date']);

/**
 * 패키지 선언으로 입력을 검사하고 기본값을 채운다. 값은 문자열만(앞뒤 공백은 잘라 낸다).
 * - 선언에 없는 키 → cert.input_unknown
 * - 값이 없고 기본값도 없는데 required → input.missing(빈 문자열도 없음으로 본다)
 * - 문자열이 아님·위험 문자·너무 김·enum 밖·date 모양 아님·지원하지 않는 선언 종류 → cert.input_invalid
 */
export function certInputs(decl: Readonly<Record<string, InputDecl>>, raw: unknown): CertInputResult {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return { ok: false, code: 'cert.input_invalid', field: '' };
  const given = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!Object.hasOwn(decl, k)) return { ok: false, code: 'cert.input_unknown', field: k.slice(0, 40).replace(/[^A-Za-z0-9_]/g, '_') };
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(decl)) {
    if (!SCALAR.has(d.type)) return { ok: false, code: 'cert.input_invalid', field: k };
    let v: unknown = given[k];
    if (typeof v === 'string') v = v.trim();
    if (v === undefined || v === null || v === '') v = d.default;
    if (v === undefined || v === null || v === '') {
      if (d.required) return { ok: false, code: 'input.missing', field: k };
      continue;
    }
    if (typeof v !== 'string' || v.length > MAX_LEN || UNSAFE.test(v)) return { ok: false, code: 'cert.input_invalid', field: k };
    const s = v.normalize('NFC');
    if (d.type === 'enum' && !(d.values ?? []).includes(s)) return { ok: false, code: 'cert.input_invalid', field: k };
    if (d.type === 'date' && !DATE.test(s)) return { ok: false, code: 'cert.input_invalid', field: k };
    out[k] = s;
  }
  return { ok: true, inputs: out };
}

/**
 * 민원증명 업무 키(원장 business_key): SHA-256(JCS{kind, playbookId, bizNo, day, inputs}). 같은 날 같은 사업자가 같은 서류를 같은 입력으로
 * 다시 떼려 하면 같은 값이다(승인 카드 $dup.businessKey). 값 자체는 원장에 해시로만 남는다.
 */
export function certBusinessKey(x: { playbookId: string; bizNo: string; day: string; inputs: Readonly<Record<string, string>> }): string {
  return createHash('sha256').update(jcs({ kind: 'cert', playbookId: x.playbookId, bizNo: x.bizNo.replace(/\D/g, ''), day: x.day, inputs: x.inputs })).digest('hex');
}
