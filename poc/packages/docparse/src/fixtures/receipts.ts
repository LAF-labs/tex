// 합성 종이 증빙 24장(가짜 상호·가짜 사업자번호, 체크섬만 맞춘다. 실명·실사업자번호 없음).
// receiptText: OCR이 낼 법한 글자(띄어쓰기·혼동 문자 잡음 선택). receiptHtml: e2e가 그림으로 찍어 샌드박스 OCR에 넣는 서식.
import { isValidBizNo } from '../util.ts';

/** 합성 사업자번호: 가운데 두 자리를 '99'로 고정해 실번호와 겹칠 가능성을 줄이고 체크섬만 맞춘다 */
export function fakeBizNo(seed: number): string {
  const head = String(100 + ((seed * 37) % 800)).padStart(3, '0');
  const tail = String(10000 + ((seed * 7919) % 89990)).slice(0, 4);
  for (let c = 0; c <= 9; c++) if (isValidBizNo(`${head}99${tail}${c}`)) return `${head}99${tail}${c}`;
  throw new Error('unreachable');
}

export const fmtBiz = (d: string) => `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
const won = (n: number) => n.toLocaleString('en-US');

export type ReceiptLayout = 'card' | 'simple' | 'cash' | 'pos' | 'tax_invoice';

export interface SyntheticReceipt {
  id: string;
  layout: ReceiptLayout;
  merchant: string;
  bizNo: string;
  date: string;
  time: string;
  items: Array<{ name: string; qty: number; price: number }>;
  approvalNo: string | null;
  cardTail: string | null;
  /** 날짜 표기 방식 */
  dateStyle: 'dash' | 'dot' | 'slash2' | 'korean';
  expected: { amount: number; supply: number | null; vat: number | null; issuedOn: string; merchant: string; bizNo: string };
}

const NAMES = ['가나다식당', '라마바커피', '사아자문구', '차카타철물', '파하분식', '가람베이커리', '나래꽃집', '다온정육점', '라온약국', '마루인쇄', '바다횟집', '새벽마트', '아름세탁', '자두카페', '초록주유소', '키움문고', '타래공방', '파랑치킨', '하늘제과', '가온카센터', '누리편의점', '도담한식', '로아미용실', '모아사무기'];
const ITEMS = [['아메리카노', 4500], ['볼펜', 1200], ['복사용지', 25000], ['김밥', 3500], ['라면', 4000], ['소모품', 8800], ['커피원두', 18000], ['화분', 15000], ['정육', 32000], ['의약품', 6500], ['명함인쇄', 22000], ['생수', 1000], ['세탁', 9000], ['식빵', 4200], ['경유', 55000], ['도서', 16800], ['재료비', 13000], ['치킨', 20000], ['케이크', 28000], ['엔진오일', 66000], ['음료', 1800], ['백반', 9000], ['커트', 15000], ['토너', 48000]] as const;
const LAYOUTS: ReceiptLayout[] = ['card', 'simple', 'cash', 'pos', 'card', 'tax_invoice'];
const STYLES: SyntheticReceipt['dateStyle'][] = ['dash', 'dot', 'slash2', 'korean'];

export function syntheticReceipts(): SyntheticReceipt[] {
  return NAMES.map((merchant, i) => {
    const [n1, p1] = ITEMS[i]!;
    const [n2, p2] = ITEMS[(i + 7) % ITEMS.length]!;
    const items = [{ name: n1, qty: 1 + (i % 3), price: p1 }, ...(i % 2 ? [{ name: n2, qty: 1, price: p2 }] : [])];
    const amount = items.reduce((s, x) => s + x.qty * x.price, 0);
    const layout = LAYOUTS[i % LAYOUTS.length]!;
    // 공급가액·부가세는 카드·POS·세금계산서 서식에만 적는다(합계 = 공급가액 + 부가세, 공급가액은 1/1.1 반올림)
    const supply = layout === 'simple' || layout === 'cash' ? null : Math.round(amount / 1.1);
    const vat = supply === null ? null : amount - supply;
    const day = 1 + ((i * 3) % 27);
    const date = `2026-${String(9 + (i % 2)).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return {
      id: `r${String(i + 1).padStart(2, '0')}`,
      layout,
      merchant,
      bizNo: fakeBizNo(i + 3),
      date,
      time: `${String(9 + (i % 12)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
      items,
      approvalNo: layout === 'card' || layout === 'pos' ? String(30000000 + i * 104729).slice(0, 8) : null,
      cardTail: layout === 'card' || layout === 'pos' ? String(1000 + ((i * 373) % 9000)) : null,
      dateStyle: STYLES[i % STYLES.length]!,
      expected: { amount, supply, vat, issuedOn: date, merchant, bizNo: fakeBizNo(i + 3) },
    };
  });
}

function dateText(r: SyntheticReceipt): string {
  const [y, m, d] = r.date.split('-');
  switch (r.dateStyle) {
    case 'dash':
      return `${r.date} ${r.time}`;
    case 'dot':
      return `${y}.${m}.${d} ${r.time}`;
    case 'slash2':
      return `${y!.slice(2)}/${m}/${d} ${r.time}`;
    case 'korean':
      return `${y}년 ${Number(m)}월 ${Number(d)}일`;
  }
}

/** 영수증 줄(위에서 아래로). HTML·글자 모두 이 줄로 만든다 */
export function receiptLines(r: SyntheticReceipt): string[] {
  const L: string[] = [];
  const total = r.expected.amount;
  const itemLines = r.items.map((x) => `${x.name}  ${x.qty}  ${won(x.price)}  ${won(x.qty * x.price)}`);
  switch (r.layout) {
    case 'card':
      L.push('신용카드 매출전표', '(고객용)', `가맹점명: ${r.merchant}`, `사업자번호: ${fmtBiz(r.bizNo)}`, '대표자: 김가상  TEL 02-000-1234', `거래일시: ${dateText(r)}`, `카드번호: 9410-12**-****-${r.cardTail}`, '할부: 일시불', '----------------------------', ...itemLines, '----------------------------', `공급가액: ${won(r.expected.supply!)}`, `부가세: ${won(r.expected.vat!)}`, `합계금액: ${won(total)}원`, `승인번호: ${r.approvalNo}`, '감사합니다');
      break;
    case 'pos':
      L.push(r.merchant, `사업자 ${fmtBiz(r.bizNo)}  대표 이가상`, '서울특별시 가상구 테스트로 1', `[판매] ${dateText(r)}`, '상품명  수량  단가  금액', '----------------------------', ...itemLines, '----------------------------', `과세물품가액 ${won(r.expected.supply!)}`, `부가세 ${won(r.expected.vat!)}`, `합계 ${won(total)}`, `받을금액 ${won(total)}`, `카드 ****-****-****-${r.cardTail}`, `승인번호 ${r.approvalNo}`);
      break;
    case 'simple':
      L.push('간이영수증', `상호: ${r.merchant}`, `사업자등록번호: ${fmtBiz(r.bizNo)}`, `작성일자: ${dateText(r)}`, '품목  수량  단가  금액', ...itemLines, `합계: ${won(total)}원`, '위 금액을 영수합니다.');
      break;
    case 'cash':
      L.push('현금영수증(지출증빙)', `가맹점: ${r.merchant}`, `사업자번호 ${fmtBiz(r.bizNo)}`, `거래일자 ${dateText(r)}`, '식별번호 010-****-0000', ...itemLines, `총액 ${won(total)}원`, '국세청 홈택스 확인 가능');
      break;
    case 'tax_invoice':
      L.push('세 금 계 산 서 (공급받는자 보관용)', `등록번호 ${fmtBiz(r.bizNo)}`, `상호 ${r.merchant}  성명 박가상`, '사업장주소 가상시 테스트동 2', `작성일자 ${dateText(r)}`, '품목  수량  단가  공급가액  세액', ...r.items.map((x) => `${x.name}  ${x.qty}  ${won(x.price)}  ${won(Math.round((x.qty * x.price) / 1.1))}`), `공급가액 ${won(r.expected.supply!)}`, `세액 ${won(r.expected.vat!)}`, `합계금액 ${won(total)}`, '이 금액을 (청구) 함');
      break;
  }
  return L;
}

/**
 * OCR 잡음 흉내(순수 테스트용): 라벨 띄어쓰기, 숫자 0을 O로, 쉼표를 점으로, 줄 하나에 잡자모.
 * level 0은 깨끗한 글자.
 */
export function receiptText(r: SyntheticReceipt, level: 0 | 1 | 2 = 0): string {
  const lines = receiptLines(r);
  if (level === 0) return lines.join('\n');
  return lines
    .map((l, k) => {
      let s = l;
      if (/합계|부가세|공급가액|사업자|거래일시/.test(s) && level >= 1) s = s.replace(/(합계|부가세|공급가액|사업자)/, (w) => w.split('').join(' '));
      if (level >= 2 && k % 3 === 0) s = s.replace(/,/g, '.');
      if (level >= 2 && /승인번호/.test(s)) s = s.replace(/0/, 'O');
      if (level >= 2 && k === 1) s = `${s} ㅣ`;
      return s;
    })
    .join('\n');
}

/** e2e 그림용 HTML(감열지 느낌: 좁은 폭·고정폭 글꼴·옅은 회색 글자). tilt는 기울기(도) */
export function receiptHtml(r: SyntheticReceipt, o: { tilt?: number; faded?: boolean } = {}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const color = o.faded ? '#555' : '#111';
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#e9e6df}
.r{width:520px;margin:30px auto;padding:28px 30px;background:#fbfaf6;color:${color};font:26px/1.5 'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',monospace;transform:rotate(${o.tilt ?? 0}deg);box-shadow:0 2px 6px rgba(0,0,0,.25)}
.r p{margin:0;white-space:pre-wrap}
.stamp{position:absolute;margin:-120px 0 0 360px;width:110px;height:110px;border:5px solid #d22;border-radius:50%;color:#d22;font-size:22px;display:flex;align-items:center;justify-content:center;opacity:.8}
</style><div class="r">${receiptLines(r).map((l) => `<p>${esc(l)}</p>`).join('')}${r.layout === 'simple' || r.layout === 'tax_invoice' ? '<div class="stamp">(인)</div>' : ''}</div>`;
}
