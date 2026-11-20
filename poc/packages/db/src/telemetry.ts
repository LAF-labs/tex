
type Shape = 'code' | 'date' | 'hour' | 'bucket' | 'bucketMap' | 'int' | 'bool' | 'digest' | 'intList' | 'confidence' | { enum: readonly string[] };

interface EventSpec {
  required: Record<string, Shape>;
  optional?: Record<string, Shape>;
}

const TRIGGER = { enum: ['local', 'remote', 'daemon'] } as const;

export const TELEMETRY_EVENTS: Readonly<Record<string, EventSpec>> = {
  'run.daily': {
    required: { playbook: 'code', portal: 'code', date: 'date', counts: 'bucketMap', trigger: TRIGGER, appVer: 'code', os: 'code' },
    optional: { l1Calls: 'bucket', l2Calls: 'bucket', handoffs: 'bucket', captchaCount: 'bucket' },
  },
  'step.fail': {
    required: { playbook: 'code', stepId: 'code', stableId: 'code', code: 'code', hour: 'hour', count: 'bucket' },
    optional: { failedCandidateIdx: 'intList' },
  },
  'selector.repair.daily': { required: { playbook: 'code', stableId: 'code', proposedKind: 'code', verified: 'bool', proposalDigest: 'digest', counts: 'bucket' } },
  'block.signal.daily': { required: { portal: 'code', counts: 'bucketMap' }, optional: { cooldownHours: 'int' } },
  'decide.stats.daily': { required: { bundle: 'code', outcome: 'code', confidenceBucket: 'confidence', counts: 'bucket' }, optional: { refusedQuestions: 'bucketMap' } },
  'ledger.daily': { required: { playbook: 'code', date: 'date', counts: 'bucketMap' } },
  'policy.applied.daily': { required: { policyVer: 'code', keyEpoch: 'int', portal: 'code', paceProfile: 'code', counts: 'bucket' } },
  'security.daily': { required: { counts: 'bucketMap' } },
  'policy.clamped': { required: { policyVer: 'code', field: 'code' } },
  'registry.health': { required: { statusAgeBucket: { enum: ['<48h', '48~72h', '>72h'] }, lastIndexVer: 'int' } },
};

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,63}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HOUR = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3])$/;
const DIGEST = /^[0-9a-f]{16,64}$/;

/** 건수를 5건 단위 버킷으로(올림). 0은 0, 1~5는 5. */
export const bucket5 = (n: number): number => (n <= 0 ? 0 : Math.ceil(n / 5) * 5);

const isBucket = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v % 5 === 0;

function fits(shape: Shape, v: unknown): boolean {
  if (typeof shape === 'object') return typeof v === 'string' && shape.enum.includes(v);
  switch (shape) {
    case 'code':
      return typeof v === 'string' && CODE.test(v);
    case 'date':
      return typeof v === 'string' && DATE.test(v);
    case 'hour':
      return typeof v === 'string' && HOUR.test(v);
    case 'bucket':
      return isBucket(v);
    case 'bucketMap':
      return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length <= 32 && Object.entries(v).every(([k, n]) => CODE.test(k) && isBucket(n));
    case 'int':
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    case 'bool':
      return typeof v === 'boolean';
    case 'digest':
      return typeof v === 'string' && DIGEST.test(v);
    case 'intList':
      return Array.isArray(v) && v.length <= 16 && v.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < 100);
    case 'confidence':
      return typeof v === 'number' && v >= 0 && v <= 1 && Math.abs(v * 20 - Math.round(v * 20)) < 1e-9;
  }
}

export type TelemetryCheck =
  | { ok: true; event: Record<string, unknown>; dropped: string[] }
  | { ok: false; reason: 'not_object' | 'unknown_event' | 'missing_field' | 'bad_shape'; field?: string };

/** 이벤트 객체({event, ...필드})를 검사해 허용 필드만 남긴 새 객체를 돌려준다. */
export function shapeTelemetry(input: unknown): TelemetryCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: 'not_object' };
  const o = input as Record<string, unknown>;
  const name = o.event;
  const spec = typeof name === 'string' ? TELEMETRY_EVENTS[name] : undefined;
  if (!spec) return { ok: false, reason: 'unknown_event' };
  const out: Record<string, unknown> = { event: name };
  for (const [k, shape] of Object.entries(spec.required)) {
    if (!(k in o)) return { ok: false, reason: 'missing_field', field: k };
    if (!fits(shape, o[k])) return { ok: false, reason: 'bad_shape', field: k };
    out[k] = o[k];
  }
  for (const [k, shape] of Object.entries(spec.optional ?? {})) {
    if (!(k in o)) continue;
    if (!fits(shape, o[k])) return { ok: false, reason: 'bad_shape', field: k };
    out[k] = o[k];
  }
  const known = new Set(['event', ...Object.keys(spec.required), ...Object.keys(spec.optional ?? {})]);
  const dropped = Object.keys(o).filter((k) => !known.has(k)).map((k) => (/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) ? k : '?'));
  return { ok: true, event: out, dropped };
}
