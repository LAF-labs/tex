import { randomUUID } from 'node:crypto';
import { dayOffset, hm, type Doc, type DocStore, type G24Doc, type Profile } from './shell-model.ts';

// 견본 데이터(시연·e2e 전용, ADR-035 W-7). 모든 값은 가상이다. 제품 진입점(shell.ts)은 이 파일에 닿지 않는다:
// 셸은 시연 연결(ShellDev.sample, demo-dev.ts)로만 받는다. 화면 모델·요청 해석은 shell-model.ts다(여기서 다시 내보낸다).
export * from './shell-model.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export const PROFILES: Record<Profile['kind'], Profile> = {
  business: { kind: 'business', name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', email: 'office@ganada.example', auth: '사업자 간편인증(카카오뱅크)' },
  personal: { kind: 'personal', name: '김가나', email: 'gana@ganada.example', auth: '간편인증(카카오톡)' },
};

/** 셸 하나의 목업 문서함. 모듈 전역에 두지 않고 셸마다 새로 만든다. 보관함(PoC-8 documents)과는 아직 잇지 않는다. */
export class MockStore implements DocStore {
  /** 목업 서류의 견본 PDF 경로(시연 씨앗, demo-seed.ts). main 안에서만 쓰고 렌더러에 보내지 않는다. */
  readonly files = new Map<string, string>();
  readonly docs: Doc[] = [
    { id: 'd1', name: '납세증명서(국세)', kind: '증명서', docName: '납세증명서', profile: 'business', issuedOn: dayOffset(-25), expiresOn: dayOffset(5), source: '앱이 발급', purpose: '입찰 제출' },
    { id: 'd2', name: '사업자등록증명', kind: '증명서', docName: '사업자등록증명', profile: 'business', issuedOn: dayOffset(-12), expiresOn: null, source: '앱이 발급', purpose: '거래처 등록' },
    { id: 'd3', name: '세금계산서 · B상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-1), expiresOn: null, source: '앱이 발급' },
    { id: 'd4', name: '세금계산서 · A상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-32), expiresOn: null, source: '앱이 발급' },
    { id: 'd5', name: '중소기업확인서', kind: '직접 추가', docName: '중소기업확인서', profile: 'business', issuedOn: dayOffset(-210), expiresOn: dayOffset(150), source: '직접 추가' },
    { id: 'd6', name: '주민등록표 등본', kind: '증명서', docName: '주민등록표 등본', profile: 'personal', issuedOn: dayOffset(-47), expiresOn: null, source: '직접 발급', purpose: '은행 제출' },
  ];

  /** 정부24 직접 발급 파일을 문서함에 넣는다(사용자가 후보를 고른 뒤). */
  g24Save(candidateId: string, doc: G24Doc): Doc {
    if (candidateId !== 'f1' && candidateId !== 'f2') throw new Error('bad_candidate');
    const d: Doc = { id: `d-g24-${randomUUID().slice(0, 6)}`, name: doc, kind: '증명서', docName: doc, profile: 'personal', issuedOn: dayOffset(0), expiresOn: null, source: '직접 발급', purpose: '제출처 확인 필요' };
    this.docs.unshift(d);
    return d;
  }
}

/**
 * 이번 달 판 목업 어댑터(ADR-033, M6-16). 세무사 꾸러미(D-05, 2차 배분)·사업용 카드(D-04) 데이터가 들어오기 전 자리다.
 * 지난달 꾸러미 칸 상태와 카드 내역 마지막 최신화 날짜. 꾸러미 트랙의 공개 인터페이스가 나오면 그쪽 질의로 바꾼다.
 */
export function mockBundle(today: string): { month: string; slots: Array<{ name: string; state: 'missing' | 'done' | 'na'; receipt?: boolean }>; sentOn: null } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) - 1;
  const month = `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
  return {
    month,
    slots: [
      { name: '매출(세금계산서)', state: 'done' },
      { name: '매입(세금계산서)', state: 'done' },
      { name: '사업용 카드 내역', state: 'missing' },
      { name: '종이 영수증', state: 'missing', receipt: true },
      { name: '현금매출', state: 'na' },
    ],
    sentOn: null,
  };
}
export const MOCK_SETTINGS = { reminderDay: 5, cardFetchedOn: dayOffset(-38) };

/** 대화 타임라인 첫 화면(지난 기록). 단일 세션이라 지난 일은 같은 타임라인 위쪽에 있다(ADR-019). */
export function seedTimeline(): unknown[] {
  return [
    { type: 'day', date: dayOffset(-4) },
    { type: 'app', text: '등록을 마쳤어요. 맡기신 일은 입력창 위 빠른 실행에 넣어 두었어요.' },
    { type: 'summary', rows: [['사업자', '가나다컴퍼니 · 123-45-67891'], ['발급 인증', '사업자 간편인증(카카오뱅크)'], ['거래처', '3곳'], ['맡긴 업무', '세금계산서 발급, 사업자등록증명, 납세증명서']] },
    { type: 'day', date: dayOffset(-1) },
    { type: 'me', text: 'B상사에 55만원 세금계산서 끊어 줘', time: '16:20' },
    { type: 'past', title: '세금계산서', who: 'B상사', total: 605000, supply: 550000, tax: 55000, approvalNo: `${dayOffset(-1).replaceAll('-', '')}-41000012-00000123`, mail: 'account@bsangsa.example' },
    { type: 'day', date: dayOffset(0) },
  ];
}

// ---- 정부24 후처리 목업(T-08). 정부24에 어떤 요청도 보내지 않고 브라우저도 열지 않는다(ADR-011, D17). ----

/** 작업 시작 뒤에 생긴 PDF만 후보로 올린다(D17 §1.3). 목업은 시작~지금 사이 시각으로 만든다. */
export function g24Candidates(doc: G24Doc, startedAt: number): Array<{ id: string; name: string; size: string; at: string }> {
  const now = Date.now();
  const start = Number.isFinite(startedAt) && startedAt <= now ? startedAt : now;
  const at = (f: number) => hm(new Date(start + (now - start) * f));
  return [
    { id: 'f1', name: `${doc.replace(/\s/g, '')}_${dayOffset(0).replaceAll('-', '')}.pdf`, size: '182KB', at: at(0.9) },
    { id: 'f2', name: 'print_0001.pdf', size: '96KB', at: at(0.4) },
  ];
}

