// H-01 실화면 패키지(hometax.invoice.issue 2.2.0 + 조회 1.2.0) 건조 실행 하네스. 가짜 홈택스(tests/hometax-fake.ts)에 로그인 구간부터 끝까지 돌린다.
// "가짜 통과 = 실제로 됨"에 가깝게: 패키지는 제품 원본(packages/engine/playbooks)을 그대로 쓰고, 바꾸는 것은 fixtureFiles의 다섯 가지뿐이다
// (시험 h01-real-dryrun.test.ts가 그 밖에 차이가 없는지 본다).
//   1) URL origin https://hometax.go.kr → 가짜 화면 origin   2) 엔드포인트 host teet.hometax.go.kr → 가짜 teet host
//   3) manifest.domains → 127.0.0.1   4) portal → fixture(ADR-039)   5) 서명(시험 키)
// 셀렉터 id·스텝·signFlow·조회 열은 한 글자도 바꾸지 않는다. 실행에서 바꾸는 시간 값(verifyTiming·verify 정책)은 fixture 허가 뒤에서만 먹는다.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunService, type GatePortMessage, type IrPackage, type RunEvent } from '@sax/engine';
import { FIXTURE_PORTAL, fixtureOriginGrant, loadPackage, type LoadedPackage, type LoaderContext, type PackageFiles, type PdfPort } from '@sax/engine/core';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { bundleOutcomes, loadPkg, signPackage, testKeys } from './core-fixtures.ts';
import { startHarness } from './harness.ts';
import { startHometaxFake, type FakeKnobs, type HometaxFake } from './hometax-fake.ts';

export const REAL_ORIGIN = 'https://hometax.go.kr';
export const REAL_TEET = 'teet.hometax.go.kr';
export const PACKAGE_IDS = ['hometax.invoice.lookup', 'hometax.invoice.email_status', 'hometax.invoice.issue'] as const;

/** 제품 원본 → 가짜 홈택스용(위 다섯 가지만). */
export function fixtureFiles(files: PackageFiles, origin: string, teetHost: string): PackageFiles {
  const text = JSON.stringify(files)
    .replaceAll(`"${REAL_ORIGIN}`, `"${origin}`)
    .replaceAll(`"host":"${REAL_TEET}"`, `"host":"${teetHost}"`);
  const out = JSON.parse(text) as PackageFiles;
  out.manifest.domains = ['127.0.0.1'];
  out.manifest.portal = out.playbook.portal = out.selectors.portal = FIXTURE_PORTAL;
  return out;
}

export function loadReal(origin: string, teetHost: string, patchIssue?: (files: PackageFiles) => void): { pkg: LoadedPackage; lookups: Map<string, LoadedPackage> } {
  const keys = testKeys();
  const two = keys.pkg.slice(0, 2);
  const ctx = (installedLookups: ReadonlyMap<string, LoadedPackage>): LoaderContext => ({
    roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups,
    storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now(),
  });
  const lookups = new Map<string, LoadedPackage>();
  for (const id of PACKAGE_IDS.slice(0, 2)) {
    const r = loadPackage(signPackage(fixtureFiles(loadPkg(id), origin, teetHost), two), ctx(new Map()));
    if (!r.ok) throw new Error(`조회 패키지 ${id}: ${r.code} ${JSON.stringify(r.violations)}`);
    lookups.set(id, r.pkg);
  }
  const files = fixtureFiles(loadPkg('hometax.invoice.issue'), origin, teetHost);
  patchIssue?.(files);
  const r = loadPackage(signPackage(files, two, files.manifest.lookupsUsed.map((l) => lookups.get(l.id)?.manifestDigest ?? '0'.repeat(64))), ctx(lookups));
  if (!r.ok) throw new Error(`발급 패키지: ${r.code} ${JSON.stringify(r.violations)}`);
  return { pkg: r.pkg, lookups };
}

const PDF: PdfPort = {
  print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
  armDownload: async () => ({ armed: false, reason: 'n/a' }),
  awaitDownload: async () => ({ ok: false, reason: 'n/a' }),
  disarmDownload: async () => {},
  store: async () => ({ ok: true, documentId: 'doc-1' }),
};

export interface Scenario {
  knobs?: Partial<FakeKnobs>;
  loggedIn?: boolean;
  signMethod?: 'cert' | 'simple_auth' | 'security_card';
  /** 거래처 등록번호(가짜 registry 키). */
  bizNo?: string;
  email?: string | null;
  supply?: number;
  /** 사람 흉내(실행 중 반복 호출). 기본: 로그인 화면이면 로그인, 인증서 창이면 [확인]. */
  human?: (fx: HometaxFake) => void;
  approve?: boolean;
  maxMs?: number;
  verifyMaxMs?: number;
  /** 공동인증서 비밀번호 금고(IrPackage.secret, engine-cert B1·B2). 없으면 human:secret은 대역(바로 ttl). */
  secret?: IrPackage['secret'];
  /** 발급 패키지 파일 고치기(시험이 고른 변형만, 시나리오에 적는다). */
  patchIssue?: (files: PackageFiles) => void;
}

export interface Outcome {
  end: (RunEvent & { status?: string; code?: string; approvalNo?: string; mailConfirmed?: boolean }) | undefined;
  journal: string[];
  steps: string[];
  gate: boolean;
  fx: HometaxFake;
  /** teet로 간 actionId 순서(permission.do는 perm:<screenId>). */
  actions: string[];
}

export const defaultHuman = (fx: HometaxFake) => {
  // 사람은 로그인 화면이 뜬 뒤에(그려지고 조금 지나) 로그인을 마친다.
  const ls = fx.state.lastScreen;
  if (!fx.state.loggedIn && ls?.screen === 'login' && Date.now() - ls.at > fx.knobs.renderDelayMs + 1500) fx.login();
  // 인증서 창이 뜨고 사람이 비밀번호를 넣는 데 시간이 든다.
  if (fx.state.stage === 'cert' && Date.now() - fx.state.certAt > 1500) fx.cert('confirm');
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function realDryRun(sc: Scenario = {}): Promise<Outcome> {
  const fx = await startHometaxFake({ renderDelayMs: 600, ...sc.knobs, loggedIn: sc.loggedIn ?? false });
  const teetHost = new URL(fx.teetOrigin).host;
  const h = await startHarness();
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-real-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const events: RunEvent[] = [];
  const gm: GatePortMessage[] = [];
  const steps: string[] = [];
  try {
    const { pkg, lookups } = loadReal(fx.origin, teetHost, sc.patchIssue);
    const base = fixturePortal(fx.origin);
    // 가짜 화면은 로드 뒤 renderDelayMs에 그린다. 조회 팝업 한 번에 1~2초라 verify 상한을 늘린다(fixture 허가 뒤에서만).
    const portal = { ...base, verify: { ...base.verify, maxMs: sc.verifyMaxMs ?? 25_000, intervalMs: 300 } };
    const ir: IrPackage = { pkg, lookupPackages: lookups, fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: 600, lookups: 2, maxMs: sc.verifyMaxMs ?? 25_000 }, pdf: PDF, ...(sc.secret ? { secret: sc.secret } : {}) };
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김대표', bizType: null, bizItem: null, address: null, email: null, signMethod: sc.signMethod ?? 'cert' } as never);
    const email = sc.email === undefined ? 'tax@asangsa.example' : sc.email;
    const cp = data.counterparties.create({ bizNo: sc.bizNo ?? '2148651233', name: '에이상사', repName: '이대표', address: '부산광역시 가짜구 1', ...(email ? { email } : {}) }).id;
    const rb = await connectRunBrowser(h.client);
    const runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal, log: new FileEventLog(null, 'engine'), page: async () => rb.page,
      postGate: (m: GatePortMessage) => gm.push(m), engine: 'ir', irSource: () => ({ ok: true, ir }),
      trace: (_r: string, t: { name: string; stepId: string; code?: string }) => {
        if (t.name === 'step.finished') steps.push(t.code ? `${t.stepId}!${t.code}` : t.stepId);
      },
    } as never);
    runs.on('event', (e: RunEvent) => events.push(e));
    const ended = () => events.find((e) => e.type === 'end');
    runs.start({ runId: 'r1', counterpartyId: cp, supply: sc.supply ?? 1000, tax: Math.floor((sc.supply ?? 1000) / 10), itemName: '테스트', ...(email === null ? { email: null } : {}) } as never);
    const t0 = Date.now();
    let approved = false;
    const human = sc.human ?? defaultHuman;
    while (!ended() && Date.now() - t0 < (sc.maxMs ?? 90_000)) {
      human(fx);
      const g = gm.find((m) => m.t === 'gate.request');
      if (g && !approved && sc.approve !== false && g.t === 'gate.request') {
        approved = true;
        const q = g.req;
        runs.answer({ v: 2, runId: q.runId, gateStepId: q.gateStepId, reqId: q.reqId, approvalNonce: q.approvalNonce, actionHash: q.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' });
      }
      await sleep(100);
    }
    const journal = runs.inspect('r1').journal;
    try {
      runs.stop('r1');
    } catch {
      /* 끝남 */
    }
    await rb.browser.close().catch(() => {});
    return { end: ended() as Outcome['end'], journal, steps, gate: gm.some((m) => m.t === 'gate.request'), fx, actions: fx.requests().map((r) => r.actionId ?? `perm:${r.screenId}`) };
  } finally {
    db.close();
    await h.close();
    await fx.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
