// 받을 돈(09 D-09) 렌더러 요청 표. ipc.ts SHELL_METHODS에 펼쳐 넣는다(같은 검사: 표에 없는 필드·틀린 형·넘친 길이는 bad_request).
// 렌더러는 계좌번호 전체를 [보기]·[계좌 추가]에서만 다룬다. 파일 바이트·경로는 오가지 않는다(main이 고르고 읽는다).
const ID = { t: 'string', max: 128, required: true } as const;
const COLS = {
  t: 'object',
  fields: {
    headerRow: { t: 'number' }, date: { t: 'number' }, time: { t: 'number' }, in: { t: 'number' }, out: { t: 'number' }, amount: { t: 'number' }, kind: { t: 'number' },
    balance: { t: 'number' }, payer: { t: 'number' }, memo: { t: 'number' }, counter_account: { t: 'number' },
  },
} as const;
export const BANK_METHODS_LIST = ['account', 'cash', 'other_account', 'offset', 'other'] as const;

export const BANK_SHELL_METHODS = {
  'bank.overview': {},
  'bank.receivable': { id: ID },
  'bank.consent': {},
  'bank.addAccount': { bank: { t: 'string', max: 40, required: true }, number: { t: 'string', max: 40, required: true }, alias: { t: 'string', max: 60 } },
  'bank.deleteAccount': { id: ID },
  'bank.revealAccount': { id: ID },
  // 자동 연결 계좌 최신화(원천 → 넣기 → 맞추기). 시작만 하고 돌아온다. 진행은 refreshStatus로 본다
  'bank.refresh': { accountId: ID },
  'bank.refreshStatus': { accountId: ID },
  'bank.pickStatement': {},
  'bank.previewStatement': { token: { t: 'string', max: 32, required: true }, columns: COLS },
  'bank.commitStatement': { token: { t: 'string', max: 32, required: true }, accountId: ID, columns: COLS },
  'bank.cancelStatement': {},
  'bank.pickInvoices': {},
  // ids: 건 id를 쉼표로 이은 것(합산 입금 후보는 여러 건)
  'bank.accept': { txnId: ID, ids: { t: 'string', max: 1400, required: true }, closeFee: { t: 'boolean' } },
  'bank.attach': { txnId: ID, receivableId: ID },
  'bank.detach': { allocId: ID },
  'bank.reject': { txnId: ID, receivableId: ID },
  'bank.markReceived': { receivableId: ID, method: { t: 'enum', of: BANK_METHODS_LIST, required: true }, amount: { t: 'number' }, on: { t: 'string', max: 10 }, memo: { t: 'string', max: 200 } },
  'bank.closeFee': { receivableId: ID },
  'bank.ignoreTxn': { txnId: ID, reason: { t: 'enum', of: ['unrelated', 'interest', 'own_transfer', 'card_sales', 'other'], nullable: true, required: true } },
  'bank.assignTxn': { txnId: ID, counterpartyId: ID, remember: { t: 'boolean' } },
  'bank.setPromised': { receivableId: ID, on: { t: 'string', max: 10, nullable: true, required: true } },
  'bank.exclude': { receivableId: ID, reason: { t: 'string', max: 200, nullable: true, required: true } },
  'bank.undo': { seq: { t: 'number', required: true } },
  'bank.cpBanking': { counterpartyId: ID },
  'bank.addCpAccount': { counterpartyId: ID, bank: { t: 'string', max: 40 }, number: { t: 'string', max: 40, required: true }, holder: { t: 'string', max: 60 } },
  'bank.deleteCpAccount': { id: ID },
  'bank.addAlias': { counterpartyId: ID, name: { t: 'string', max: 60, required: true } },
  'bank.deleteAlias': { id: ID },
  'bank.setPayTerms': { counterpartyId: ID, kind: { t: 'enum', of: ['default', 'days', 'next_month_day', 'month_end', 'none'], required: true }, n: { t: 'number' } },
} as const;

/** 계좌 추가 동의 문구 판(09 §9.4 첫 문구). 문구를 바꾸면 판을 올린다 */
export const BANK_CONSENT_VERSION = '09-file-v1';
