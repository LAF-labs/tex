import { randomUUID } from 'node:crypto';
import { dayOffset, hm, type Doc, type DocStore, type G24Doc, type Profile } from './shell-model.ts';

export * from './shell-model.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export const PROFILES: Record<Profile['kind'], Profile> = {
  business: { kind: 'business', name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', email: 'office@ganada.example', auth: '사업자 간편인증(카카오뱅크)' },
  personal: { kind: 'personal', name: '김가나', email: 'gana@ganada.example', auth: '간편인증(카카오톡)' },
};

export class MockStore implements DocStore {
  readonly files = new Map<string, string>();
  readonly docs: Doc[] = [
    { id: 'd1', name: '납세증명서(국세)', kind: '증명서', docName: '납세증명서', profile: 'business', issuedOn: dayOffset(-25), expiresOn: dayOffset(5), source: '앱이 발급', purpose: '입찰 제출' },
    { id: 'd2', name: '사업자등록증명', kind: '증명서', docName: '사업자등록증명', profile: 'business', issuedOn: dayOffset(-12), expiresOn: null, source: '앱이 발급', purpose: '거래처 등록' },
    { id: 'd3', name: '세금계산서 B상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-1), expiresOn: null, source: '앱이 발급' },
    { id: 'd4', name: '세금계산서 A상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-32), expiresOn: null, source: '앱이 발급' },
    { id: 'd5', name: '중소기업확인서', kind: '직접 추가', docName: '중소기업확인서', profile: 'business', issuedOn: dayOffset(-210), expiresOn: dayOffset(150), source: '직접 추가' },
    { id: 'd6', name: '주민등록표 등본', kind: '증명서', docName: '주민등록표 등본', profile: 'personal', issuedOn: dayOffset(-47), expiresOn: null, source: '직접 발급', purpose: '은행 제출' },
  ];

  g24Save(candidateId: string, doc: G24Doc): Doc {
    if (candidateId !== 'f1' && candidateId !== 'f2') throw new Error('bad_candidate');
    const d: Doc = { id: `d-g24-${randomUUID().slice(0, 6)}`, name: doc, kind: '증명서', docName: doc, profile: 'personal', issuedOn: dayOffset(0), expiresOn: null, source: '직접 발급', purpose: '제출처 확인 필요' };
    this.docs.unshift(d);
    return d;
  }
}

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

export function seedTimeline(): unknown[] {
  return [
    { type: 'day', date: dayOffset(-4) },
    { type: 'app', text: '등록을 마쳤어요. 맡기신 일은 입력창 위 빠른 실행에 넣어 두었어요.' },
    { type: 'summary', rows: [['사업자', '가나다컴퍼니, 123-45-67891'], ['발급 인증', '사업자 간편인증(카카오뱅크)'], ['거래처', '3곳'], ['맡긴 업무', '세금계산서 발급, 사업자등록증명, 납세증명서']] },
    { type: 'day', date: dayOffset(-1) },
    { type: 'me', text: 'B상사에 55만원 세금계산서 끊어 줘', time: '16:20' },
    { type: 'past', title: '세금계산서', who: 'B상사', total: 605000, supply: 550000, tax: 55000, approvalNo: `${dayOffset(-1).replaceAll('-', '')}-41000012-00000123`, mail: 'account@bsangsa.example' },
    { type: 'day', date: dayOffset(0) },
  ];
}

export function g24Candidates(doc: G24Doc, startedAt: number): Array<{ id: string; name: string; size: string; at: string }> {
  const now = Date.now();
  const start = Number.isFinite(startedAt) && startedAt <= now ? startedAt : now;
  const at = (f: number) => hm(new Date(start + (now - start) * f));
  return [
    { id: 'f1', name: `${doc.replace(/\s/g, '')}_${dayOffset(0).replaceAll('-', '')}.pdf`, size: '182KB', at: at(0.9) },
    { id: 'f2', name: 'print_0001.pdf', size: '96KB', at: at(0.4) },
  ];
}

