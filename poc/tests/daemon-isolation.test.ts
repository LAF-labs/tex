// 데몬 격리 증명(D14 M4-8 완료 기준, ADR-026, D10 §6): @sax/daemon은 네트워크·금고·엔진 실행·Electron을 부르지 않는다.
// 1) 정적: 소스의 import를 허용 목록과 대조한다. 값 import는 @sax/engine/core의 상수·순수 판정 함수 셋뿐이고,
//    @sax/db·@sax/bundle은 타입만 쓴다. fetch·소켓·자식 프로세스·환경 변수·실제 시계(Date.now·new Date())도 없다.
// 2) 엔진 core가 끌어오는 모듈도 core 밖(금고·네트워크·브라우저)으로 나가지 않는다.
// 3) 실행: 네트워크 전역을 덫으로 바꾼 뒤 스케줄러 한 바퀴를 돌려도 덫이 울리지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DaemonScheduler, type DaemonNotification } from '@sax/daemon';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'packages/daemon/src');
const files = fs.readdirSync(src).filter((f) => f.endsWith('.ts'));
const read = (f: string) => fs.readFileSync(path.join(src, f), 'utf8');
/** 주석을 지운 코드(주석 속 설명 문구에 걸리지 않게) */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

interface Imp {
  file: string;
  spec: string;
  typeOnly: boolean;
  names: string[];
}
function imports(f: string): Imp[] {
  const out: Imp[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g;
  for (const m of code(read(f)).matchAll(re)) {
    const names = (m[2]!.match(/\{([\s\S]*)\}/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    out.push({ file: f, spec: m[3]!, typeOnly: !!m[1] || (names.length > 0 && names.every((n) => n.startsWith('type '))), names });
  }
  return out;
}

const ENGINE_VALUES = new Set(['POLICY_POLL_MIN', 'policyFreshness', 'statusFreshness']);

describe('정적 격리', () => {
  it('import는 상대 경로·@sax/engine/core(상수·판정)·@sax/db·@sax/bundle(타입만)뿐', () => {
    assert.ok(files.length >= 7);
    for (const i of files.flatMap(imports)) {
      if (i.spec.startsWith('./')) continue;
      if (i.spec === '@sax/engine/core') {
        const values = i.names.filter((n) => !n.startsWith('type '));
        for (const v of values) assert.ok(ENGINE_VALUES.has(v), `${i.file}: @sax/engine/core 값 import ${v}는 허용 목록 밖`);
        continue;
      }
      if (i.spec === '@sax/db' || i.spec === '@sax/bundle') {
        assert.ok(i.typeOnly, `${i.file}: ${i.spec}는 타입만 import한다`);
        continue;
      }
      assert.fail(`${i.file}: 허용되지 않은 import ${i.spec}`);
    }
  });
  it('네트워크·프로세스·환경·실제 시계·동적 import가 없다', () => {
    const banned: Array<[RegExp, string]> = [
      [/\bfetch\s*\(/, 'fetch'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bWebSocket\b/, 'WebSocket'],
      [/\brequire\s*\(/, 'require'],
      [/\bimport\s*\(/, 'dynamic import'],
      [/\bprocess\./, 'process'],
      [/\bDate\.now\s*\(/, 'Date.now'],
      [/new Date\(\s*\)/, 'new Date()'],
      [/\beval\s*\(/, 'eval'],
      [/node:/, 'node: 모듈'],
      [/electron/i, 'electron'],
      [/@sax\/(vault|net|remote|platform|model)\b/, '금고·네트워크·원격 패키지'],
    ];
    for (const f of files) {
      const c = code(read(f));
      for (const [re, what] of banned) assert.ok(!re.test(c), `${f}: ${what}`);
    }
  });
  it('package.json 의존은 @sax/bundle·@sax/db·@sax/engine뿐(외부 패키지 없음)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/daemon/package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@sax/bundle', '@sax/db', '@sax/engine']);
    assert.equal(pkg.devDependencies, undefined);
  });
  it('엔진 core가 끌어오는 모듈은 core 안과 node:crypto·fs·module·ajv·@sax/db(로컬 원장 오류 타입)뿐(금고·네트워크·브라우저 없음)', () => {
    const core = path.join(root, 'packages/engine/src/core');
    // ../gate.ts는 CBOR 부호화(token.ts)만 쓰고 node:crypto뿐이다(아래에서 확인)
    const ok = new Set(['@sax/db', '../gate.ts', 'node:crypto', 'node:fs', 'node:module', 'node:path', 'node:url', 'ajv', 'ajv/dist/2020.js', 'ajv-formats']);
    for (const f of fs.readdirSync(core).filter((x) => x.endsWith('.ts'))) {
      for (const m of code(fs.readFileSync(path.join(core, f), 'utf8')).matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?'([^']+)'/g)) {
        const spec = m[1]!;
        if (spec.startsWith('./') && !spec.includes('/../')) continue;
        if (/^import\s+type\b/.test(m[0])) continue;
        assert.ok(ok.has(spec), `engine/core/${f}: ${spec}`);
      }
    }
    for (const m of code(fs.readFileSync(path.join(root, 'packages/engine/src/gate.ts'), 'utf8')).matchAll(/import\s+(type\s+)?[\s\S]*?\s+from\s+'([^']+)'/g)) {
      assert.ok(m[1] || m[2] === 'node:crypto', `engine/gate.ts: ${m[2]}`);
    }
  });
});

describe('실행 격리', () => {
  it('네트워크 전역을 덫으로 바꾸고 스케줄러를 돌려도 덫이 울리지 않는다', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, WebSocket: g.WebSocket };
    let tripped = 0;
    const trap = () => {
      tripped++;
      throw new Error('network');
    };
    g.fetch = trap;
    g.WebSocket = trap;
    try {
      let t = Date.parse('2026-11-23T10:00:00+09:00');
      const out: DaemonNotification[] = [];
      const s = new DaemonScheduler({
        clock: { now: () => t },
        source: {
          snapshot: async () => ({
            policy: null,
            status: null,
            profiles: [
              {
                profileId: 'p',
                documents: [{ id: 'd', docType: 'national_tax_cert', displayName: null, issuedAt: '2026-11-01', expiresAt: '2026-11-30', meta: null }],
                validityRules: [],
                schedules: [{ id: 's', profileId: 'p', docType: 'national_tax_cert', playbookId: 'x', mode: 'auto', windowJson: null, consentJson: null, nextDueAt: null, enabled: true }],
                settings: { reminderDay: 23, halfYearWithholding: false },
                bundleSentPeriods: [],
                missing: null,
                cardFetchedOn: null,
              },
            ],
          }),
        },
        sink: { deliver: (n) => void out.push(n) },
      });
      for (let i = 0; i < 30; i++) {
        t += 60_000;
        await s.tick();
      }
      assert.equal(tripped, 0);
      assert.deepEqual(out.map((n) => n.kind).sort(), ['bundle.ready', 'card.stale', 'doc.expiring']);
    } finally {
      g.fetch = saved.fetch;
      g.WebSocket = saved.WebSocket;
    }
  });
});
