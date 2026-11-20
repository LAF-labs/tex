import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noSecretStringify from './eslint-rules/no-secret-stringify.mjs';

const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici', 'node-fetch', 'axios', 'ws'];
const withNode = (ms) => ms.flatMap((m) => [m, `node:${m}`]);
const SEND_MSG = '제품 코드는 @sax/net egress로만 송신한다(D01 §3).';
const restrictedNet = withNode(NET_MODULES).map((name) => ({ name, message: SEND_MSG }));
const VENDOR_MSG = '공급사 SDK는 packages/model/src/adapters/*에서만 import한다(ADR-015·D04 §1).';
const VENDOR_SDKS = ['openai', '@google/genai', '@google/generative-ai', 'cohere-ai', 'ollama', 'groq-sdk'];
const restrictedVendor = VENDOR_SDKS.map((name) => ({ name, message: VENDOR_MSG }));
const vendorPatterns = [{ group: ['openai/*', '@anthropic-ai/*', '@google/genai/*', '@google/generative-ai/*', '@mistralai/*', '@upstage/*', 'groq-sdk/*', 'cohere-ai/*'], message: VENDOR_MSG }];
const DEMO_MSG = '@sax/net/demo(시연·측정 전용 송신)는 apps/desktop/src/demo-*.ts·scripts·tests에서만 import한다(ADR-035 W-5).';
const restrictedDemo = [{ name: '@sax/net/demo', message: DEMO_MSG }];
const demoPatterns = [{ group: ['@sax/net/demo/*', '**/net/src/demo', '**/net/src/demo.ts', '**/net/dist/demo.js'], message: DEMO_MSG }];
const DEMO_FILES = ['apps/desktop/src/demo-*.ts'];
const restrictedCommon = [
  ...restrictedNet,
  { name: 'electron', importNames: ['net'], message: 'electron net 금지(ADR-028 결정 6). 송신은 egress로만.' },
  ...withNode(['dns', 'worker_threads']).map((name) => ({ name, message: 'dns·worker_threads 금지(ADR-028 결정 6).' })),
];
const restrictedChild = withNode(['child_process']).map((name) => ({ name, message: 'engine·model은 프로세스를 띄우지 않는다(ADR-028 결정 6).' }));
const netPatterns = [{ group: ['node:http/*', 'node:https/*', 'undici/*'], message: SEND_MSG }];
const sendGlobals = {
  'no-restricted-globals': ['error', { name: 'fetch', message: SEND_MSG }, { name: 'XMLHttpRequest', message: 'egress 전용' }, { name: 'WebSocket', message: 'egress 전용' }],
  'no-restricted-properties': ['error', { object: 'globalThis', property: 'fetch', message: 'egress 전용' }],
};

const PORT_RULE = { selector: 'Literal[value=/--remote-debugging-port/]', message: '--remote-debugging-port 금지(D05 §3). 금지 목록 상수에서만 허용.' };
const REDACTED_RULES = [
  { selector: "TSAsExpression > TSTypeReference[typeName.name='RedactedText']", message: 'RedactedText는 @sax/redaction의 apply()만 만든다(D06 §8).' },
  { selector: "TSTypeAssertion > TSTypeReference[typeName.name='RedactedText']", message: 'RedactedText는 @sax/redaction의 apply()만 만든다(D06 §8).' },
];
const MASKED_RULES = [
  { selector: "TSAsExpression > TSTypeReference[typeName.name='MaskedShot']", message: 'MaskedShot은 엔진 driver/reader.ts maskedShot()만 만든다(가린 사진만 보낸다).' },
  { selector: "TSTypeAssertion > TSTypeReference[typeName.name='MaskedShot']", message: 'MaskedShot은 엔진 driver/reader.ts maskedShot()만 만든다(가린 사진만 보낸다).' },
];
const LOAD_RE = '/^(node:)?(net|http|https|tls|dgram|dns|http2|child_process|worker_threads|undici|node-fetch|axios|ws)$/';
const LOAD_RULES = [
  { selector: "ImportExpression[source.type!='Literal']", message: '계산된 동적 import 금지(ADR-028 결정 6). 모듈 이름은 리터럴로.' },
  { selector: `ImportExpression[source.value=${LOAD_RE}]`, message: '송신 모듈 동적 import 금지(ADR-028 결정 6).' },
  { selector: `CallExpression[arguments.0.value=${LOAD_RE}]`, message: '송신 모듈 이름을 require·createRequire로 불러오지 않는다(ADR-028 결정 6).' },
];

const SEND_SCOPE = ['packages/engine/**/*.ts', 'packages/model/**/*.ts', 'packages/vault/**/*.ts', 'packages/platform/**/*.ts', 'packages/db/**/*.ts', 'packages/payroll/**/*.ts', 'packages/bundle/**/*.ts', 'packages/docparse/**/*.ts', 'apps/desktop/src/**/*.ts'];
const SEND_EXEMPT = ['apps/desktop/src/*e2e.ts', 'apps/desktop/src/h01-fixture.ts'];
const VENDOR_ALLOWED = ['packages/model/src/adapters/**', 'tests/**', 'scripts/**'];
const SECRET_SCOPE = ['packages/**/*.ts', 'apps/desktop/src/**/*.ts'];
const SECRET_EXEMPT = ['packages/vault/src/leak/scanner.ts', 'packages/vault/src/relay/sanitize.ts', 'packages/vault/src/secret/ops.ts'];
const VAULT_PORT_LISTS = ['packages/vault/src/constants.ts', 'packages/vault/src/chrome/launch.ts'];

export default tseslint.config(
  { ignores: ['**/dist/**', 'apps/desktop/e2e-dist/**', '**/node_modules/**', 'reports/**', '.tmp/**'] },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', PORT_RULE],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: ['packages/redaction/**'],
    rules: { 'no-restricted-syntax': ['error', PORT_RULE, ...REDACTED_RULES, ...MASKED_RULES] },
  },
  {
    files: ['apps/desktop/static/**/*.js', 'apps/desktop/static/**/*.mjs', 'apps/desktop/static/**/*.cjs'],
    languageOptions: { globals: { ...globals.browser, Tesseract: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['eslint.config.mjs', 'tests/guards.test.ts', 'tests/vault-relay.test.ts', 'tests/app-smoke.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.js', '**/*.cjs'],
    ignores: VENDOR_ALLOWED,
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedVendor, ...restrictedDemo], patterns: [...vendorPatterns, ...demoPatterns] }] },
  },
  {
    files: SEND_SCOPE,
    ignores: SEND_EXEMPT,
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedCommon, ...restrictedVendor, ...restrictedDemo], patterns: [...netPatterns, ...vendorPatterns, ...demoPatterns] }], ...sendGlobals },
  },
  {
    files: DEMO_FILES,
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedCommon, ...restrictedVendor], patterns: [...netPatterns, ...vendorPatterns] }], ...sendGlobals },
  },
  {
    files: ['packages/engine/**/*.ts', 'packages/model/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedCommon, ...restrictedChild, ...restrictedVendor, ...restrictedDemo], patterns: [...netPatterns, ...vendorPatterns, ...demoPatterns] }] },
  },
  {
    files: ['packages/model/src/adapters/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedCommon, ...restrictedChild, ...restrictedDemo], patterns: [...netPatterns, ...demoPatterns] }] },
  },
  {
    files: ['packages/net/src/**/*.ts'],
    ignores: ['packages/net/src/demo.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedVendor, ...restrictedDemo], patterns: [...vendorPatterns, ...demoPatterns, { group: ['./demo', './demo.ts', './demo.js'], message: DEMO_MSG }] }] },
  },
  {
    files: SECRET_SCOPE,
    ignores: SECRET_EXEMPT,
    plugins: { sax: { rules: { 'no-secret-stringify': noSecretStringify } } },
    rules: { 'sax/no-secret-stringify': 'error' },
  },
  {
    files: ['packages/engine/**/*.ts', 'packages/model/**/*.ts', 'packages/vault/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', PORT_RULE, ...REDACTED_RULES, ...MASKED_RULES, ...LOAD_RULES] },
  },
  {
    files: VAULT_PORT_LISTS,
    rules: { 'no-restricted-syntax': ['error', ...REDACTED_RULES, ...LOAD_RULES] },
  },
  {
    files: ['packages/engine/src/driver/reader.ts'],
    rules: { 'no-restricted-syntax': ['error', PORT_RULE, ...REDACTED_RULES, ...LOAD_RULES] },
  },
  {
    files: ['tests/**/*.ts'],
    ignores: ['tests/guards.test.ts', 'tests/vault-relay.test.ts', 'tests/app-smoke.ts'],
    rules: { 'no-restricted-syntax': ['error', PORT_RULE, ...REDACTED_RULES] },
  },
);
