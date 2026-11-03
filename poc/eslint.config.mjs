// D01 §3: 제품 코드(engine·model·vault·platform·db·desktop main)는 fetch/net/http 직접 import 금지. 송신은 @sax/net의 egress 하나로만.
// D05 §3: --remote-debugging-port 사용 금지(정책 상수·린트).
// D06 §8: RedactedText는 @sax/redaction 밖에서 단언(as)으로 만들 수 없다. model·engine도 egress로만 송신한다.
// ADR-028 결정 6: electron net·dns·worker_threads 금지, engine·model은 child_process 금지, engine·model·vault는 계산된 동적 import와
// 송신 모듈 이름을 리터럴로 받는 require/createRequire 호출 금지(ajv 같은 다른 이름은 통과).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici', 'node-fetch', 'axios', 'ws'];
const withNode = (ms) => ms.flatMap((m) => [m, `node:${m}`]);
const SEND_MSG = '제품 코드는 @sax/net egress로만 송신한다(D01 §3).';
const restrictedNet = withNode(NET_MODULES).map((name) => ({ name, message: SEND_MSG }));
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
const LOAD_RE = '/^(node:)?(net|http|https|tls|dgram|dns|http2|child_process|worker_threads|undici|node-fetch|axios|ws)$/';
const LOAD_RULES = [
  { selector: "ImportExpression[source.type!='Literal']", message: '계산된 동적 import 금지(ADR-028 결정 6). 모듈 이름은 리터럴로.' },
  { selector: `ImportExpression[source.value=${LOAD_RE}]`, message: '송신 모듈 동적 import 금지(ADR-028 결정 6).' },
  { selector: `CallExpression[arguments.0.value=${LOAD_RE}]`, message: '송신 모듈 이름을 require·createRequire로 불러오지 않는다(ADR-028 결정 6).' },
];

/** 송신 규칙 범위(RETRO A-12). e2e·fixture(가짜 홈택스 서버·송신 차단 시험)는 아래에서 명시 면제한다. */
const SEND_SCOPE = ['packages/engine/**/*.ts', 'packages/model/**/*.ts', 'packages/vault/**/*.ts', 'packages/platform/**/*.ts', 'packages/db/**/*.ts', 'apps/desktop/src/**/*.ts'];
const SEND_EXEMPT = ['apps/desktop/src/*e2e.ts', 'apps/desktop/src/h01-fixture.ts'];
/** 금지 인자 목록을 문자열로 갖는 금고 파일(포트 셀렉터 한 줄만 면제). */
const VAULT_PORT_LISTS = ['packages/vault/src/constants.ts', 'packages/vault/src/chrome/launch.ts'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'reports/**'] },
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
    rules: { 'no-restricted-syntax': ['error', PORT_RULE, ...REDACTED_RULES] },
  },
  {
    // 렌더러·샌드박스 정적 스크립트(브라우저 전역), 샌드박스 preload(CommonJS 필수)
    files: ['apps/desktop/static/**/*.js', 'apps/desktop/static/**/*.mjs', 'apps/desktop/static/**/*.cjs'],
    languageOptions: { globals: { ...globals.browser, Tesseract: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['eslint.config.mjs', 'tests/guards.test.ts', 'tests/vault-relay.test.ts', 'tests/app-smoke.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: SEND_SCOPE,
    ignores: SEND_EXEMPT,
    rules: { 'no-restricted-imports': ['error', { paths: restrictedCommon, patterns: netPatterns }], ...sendGlobals },
  },
  {
    files: ['packages/engine/**/*.ts', 'packages/model/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [...restrictedCommon, ...restrictedChild], patterns: netPatterns }] },
  },
  {
    files: ['packages/engine/**/*.ts', 'packages/model/**/*.ts', 'packages/vault/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', PORT_RULE, ...REDACTED_RULES, ...LOAD_RULES] },
  },
  {
    files: VAULT_PORT_LISTS,
    rules: { 'no-restricted-syntax': ['error', ...REDACTED_RULES, ...LOAD_RULES] },
  },
);
