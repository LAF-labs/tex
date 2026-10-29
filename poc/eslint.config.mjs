// D01 §3: engine 코드베이스는 fetch/net/http 직접 import 금지. 송신은 @sax/net의 egress 하나로만.
// D05 §3: --remote-debugging-port 사용 금지(정책 상수·린트).
// D06 §8: RedactedText는 @sax/redaction 밖에서 단언(as)으로 만들 수 없다. model·engine도 egress로만 송신한다.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici', 'node-fetch', 'axios', 'ws'];
const restrictedNet = NET_MODULES.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: 'engine은 @sax/net egress로만 송신한다(D01 §3).' }));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'reports/**'] },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: "Literal[value=/--remote-debugging-port/]", message: '--remote-debugging-port 금지(D05 §3). 금지 목록 상수에서만 허용.' }],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: ['packages/redaction/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "Literal[value=/--remote-debugging-port/]", message: '--remote-debugging-port 금지(D05 §3). 금지 목록 상수에서만 허용.' },
        { selector: "TSAsExpression > TSTypeReference[typeName.name='RedactedText']", message: 'RedactedText는 @sax/redaction의 apply()만 만든다(D06 §8).' },
        { selector: "TSTypeAssertion > TSTypeReference[typeName.name='RedactedText']", message: 'RedactedText는 @sax/redaction의 apply()만 만든다(D06 §8).' },
      ],
    },
  },
  {
    // 렌더러·샌드박스 정적 스크립트(브라우저 전역), 샌드박스 preload(CommonJS 필수)
    files: ['apps/desktop/static/**/*.js', 'apps/desktop/static/**/*.cjs'],
    languageOptions: { globals: { ...globals.browser, Tesseract: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['eslint.config.mjs', 'packages/vault/src/constants.ts', 'packages/vault/src/chrome/launch.ts', 'tests/guards.test.ts', 'tests/vault-relay.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['packages/engine/**/*.ts', 'packages/model/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: restrictedNet, patterns: [{ group: ['node:http/*', 'node:https/*', 'undici/*'], message: 'engine은 @sax/net egress로만 송신한다.' }] }],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'engine은 @sax/net egress로만 송신한다.' }, { name: 'XMLHttpRequest', message: 'egress 전용' }, { name: 'WebSocket', message: 'egress 전용' }],
      'no-restricted-properties': ['error', { object: 'globalThis', property: 'fetch', message: 'egress 전용' }],
    },
  },
);
