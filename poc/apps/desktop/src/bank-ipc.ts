const ID = { t: 'string', max: 128, required: true } as const;
const COLS = {
  t: 'object',
  fields: {
    headerRow: { t: 'number' }, date: { t: 'number' }, time: { t: 'number' }, in: { t: 'number' }, out: { t: 'number' }, amount: { t: 'number' }, kind: { t: 'number' },
    balance: { t: 'number' }, payer: { t: 'number' }, memo: { t: 'number' }, counter_account: { t: 'number' },
  },
} as const;
const BANK_METHODS_LIST = ['account', 'cash', 'other_account', 'offset', 'other'] as const;

export const BANK_SHELL_METHODS = {
  'bank.overview': {},
  'bank.receivable': { id: ID },
  'bank.consent': {},
  'bank.addAccount': { bank: { t: 'string', max: 40, required: true }, number: { t: 'string', max: 40, required: true }, alias: { t: 'string', max: 60 } },
  'bank.deleteAccount': { id: ID },
  'bank.revealAccount': { id: ID },
  'bank.refresh': { accountId: ID },
  'bank.refreshStatus': { accountId: ID },
  'bank.pickStatement': {},
  'bank.previewStatement': { token: { t: 'string', max: 32, required: true }, columns: COLS },
  'bank.commitStatement': { token: { t: 'string', max: 32, required: true }, accountId: ID, columns: COLS },
  'bank.cancelStatement': {},
  'bank.pickInvoices': {},
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
  'bank.addAlias': { counterpartyId: ID, name: { t: 'string', max: 60, required: true }, learned: { t: 'boolean' } },
  'bank.deleteAlias': { id: ID },
  'bank.setPayTerms': { counterpartyId: ID, kind: { t: 'enum', of: ['default', 'days', 'next_month_day', 'month_end', 'none'], required: true }, n: { t: 'number' } },
} as const;

export const BANK_CONSENT_VERSION = '09-file-v1';
