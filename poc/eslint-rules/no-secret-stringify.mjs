const SECRET_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'passphrase', 'pin', 'otp']);
const VALUE_WORDS = new Set([...SECRET_WORDS, 'bytes', 'buf', 'buffer', 'value', 'plain', 'text', 'raw']);

export function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isSecretName(name) {
  const w = words(name);
  return w.some((x) => SECRET_WORDS.has(x)) && VALUE_WORDS.has(w[w.length - 1]);
}

const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'ChainExpression']);

function unwrap(node) {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

function nameOf(node) {
  node = unwrap(node);
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name;
  return null;
}

function secretIn(node) {
  node = unwrap(node);
  if (!node) return null;
  const n = nameOf(node);
  if (n && isSecretName(n)) return n;
  if (node.type === 'ObjectExpression') {
    for (const p of node.properties) {
      if (p.type === 'SpreadElement') {
        const s = secretIn(p.argument);
        if (s) return s;
      } else {
        const key = !p.computed && p.key.type === 'Identifier' ? p.key.name : null;
        if (p.shorthand && key && isSecretName(key)) return key;
        const s = secretIn(p.value);
        if (s) return s;
      }
    }
  }
  if (node.type === 'ArrayExpression') for (const e of node.elements) {
    const s = secretIn(e);
    if (s) return s;
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && nameOf(node.callee.object) === 'Buffer') return secretIn(node.arguments[0]);
  return null;
}

const isMember = (callee, obj, prop) =>
  callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === prop && (obj === null || nameOf(callee.object) === obj);

export default {
  meta: {
    type: 'problem',
    docs: { description: '비밀 값을 문자열·JSON으로 만들지 않는다(D05 §2)' },
    messages: { stringify: '비밀 값({{name}})을 문자열·JSON으로 만들지 않는다(D05 §2 no-secret-stringify). 비밀은 Uint8Array로만 다룬다.' },
    schema: [],
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: 'stringify', data: { name } });
    return {
      CallExpression(node) {
        const c = node.callee;
        let target = null;
        if (isMember(c, 'JSON', 'stringify') || (c.type === 'Identifier' && c.name === 'String')) target = node.arguments[0];
        else if (isMember(c, null, 'decode') && c.object.type === 'NewExpression' && nameOf(c.object.callee) === 'TextDecoder') target = node.arguments[0];
        else if (isMember(c, 'console', c.property?.name)) {
          for (const a of node.arguments) {
            const s = secretIn(a);
            if (s) return report(node, s);
          }
          return;
        } else if (isMember(c, null, 'toString') || isMember(c, null, 'join')) target = c.object;
        const s = secretIn(target);
        if (s) report(node, s);
      },
      TemplateLiteral(node) {
        if (node.parent?.type === 'TaggedTemplateExpression') return;
        for (const e of node.expressions) {
          const s = secretIn(e);
          if (s) return report(e, s);
        }
      },
      BinaryExpression(node) {
        if (node.operator !== '+') return;
        const s = secretIn(node.left) ?? secretIn(node.right);
        if (s) report(node, s);
      },
    };
  },
};
