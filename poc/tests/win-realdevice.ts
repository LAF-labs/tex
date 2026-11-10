// Windows 실기기 점검(수동 실행, Phase 1 WIN-REALDEVICE). 결과는 reports/WIN-REALDEVICE.md에 옮긴다.
// 실행: node --conditions=development tests/win-realdevice.ts <npki|keychain|chrome|acl|kill|all>
//   acl: 금고(Vault, 실제 Windows 폴더 확인)로 전용 Chrome 기동 시간(ADR-041). kill: 다운로드 중 Chrome 강제 종료 뒤 잔존물·staging(#178·#209).
//   SAX_MEASURE_DIR=reports/raw/win-realdevice 로 두면 JSON을 그 폴더에 쓴다(기본은 measure-out 규칙).
// 지키는 것:
//   - NPKI: 목록만 읽는다(scanNpki와 같은 경로). signPri.key는 열지 않는다. 소유자 이름·일련번호·경로는 출력하지 않는다(가린 값만).
//   - 키체인: 실제 항목(SovereignAX/db-key 등)은 건드리지 않는다. `rd-test/<무작위>/…` 이름만 쓰고 끝나면 지운다.
//   - Chrome: 임시 프로필만 쓴다(실 프로필 %LOCALAPPDATA%\SovereignAX\chrome-profile 아님). 127.0.0.1 가짜 페이지만 연다.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readCertInfo } from '@sax/docparse/sandbox';
import {
  KeyringItemStore,
  ITEM_MAX_BYTES,
  KEYCHAIN_SERVICE,
  OsKeyStore,
  PROFILE_RESIDUE_PATHS,
  findInstalledChrome,
  keychainBackend,
  launchChrome,
  nodeNpkiFs,
  npkiRoots,
  removeCrashDumps,
  removeProfileResidue,
  scanNpki,
  writeProfileSettings,
  type NpkiFs,
} from '@sax/vault';
import { startHarness, type Harness } from './harness.ts';
import { writeMeasure } from './measure-out.ts';
import { RawEngine } from './raw-engine.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (t0: bigint) => Number((process.hrtime.bigint() - t0) / 1_000_000n);
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);

/** PowerShell 한 줄(읽기 전용 조회). 출력은 UTF-8로 받는다(한국어 Windows 콘솔은 CP949). 상한을 넘기면 null. */
function ps(command: string, timeoutMs = 60_000): string | null {
  const cmd = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return r.error || r.status === null ? null : r.stdout;
}

// ───────────────────────── 1) NPKI 열거 ─────────────────────────

/** 이동식 드라이브 문자(DriveType 2). 조회 실패면 null. */
function removableDrives(): string[] | null {
  const out = ps("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object { $_.DeviceID }");
  return out === null ? null : out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function npki(): Promise<Record<string, unknown>> {
  const roots = npkiRoots();
  // 파일 접근 감사: signPri.key 열기·stat 0회, 연 파일은 signCert.der뿐인지(경로는 남기지 않고 개수만).
  const access = { open: 0, openNotCert: 0, keyTouched: 0 };
  const isKey = (p: string) => /signpri\.key$/i.test(p);
  const auditFs: NpkiFs = {
    lstat: (p) => ((access.keyTouched += isKey(p) ? 1 : 0), nodeNpkiFs.lstat(p)),
    readdir: (p) => nodeNpkiFs.readdir(p),
    open: (p, f) => {
      access.open++;
      if (isKey(p)) access.keyTouched++;
      if (!/signcert\.der$/i.test(p)) access.openNotCert++;
      return nodeNpkiFs.open(p, f);
    },
  };
  const t0 = process.hrtime.bigint();
  const res = await scanNpki({ fs: auditFs });
  const scanMs = ms(t0);
  const now = Date.now();
  const certs = res.certs.map((c) => {
    let info: Record<string, unknown>;
    try {
      const ci = readCertInfo(c.certDer);
      const cn = /(?:^|,)CN=([^,]*)/i.exec(ci.subject)?.[1] ?? '';
      info = {
        parsed: true,
        // 소유자 이름은 가린다(글자·길이 모두 남기지 않는다). 있는지만.
        subjectCn: cn ? '***' : '(없음)',
        issuerO: /(?:^|,)O=([^,]*)/i.exec(ci.issuer)?.[1] ?? null, // 발급 기관(CA) 이름은 개인정보가 아니다
        notAfterYm: ci.notAfter.slice(0, 7),
        expired: Date.parse(ci.notAfter) < now,
      };
    } catch (e) {
      info = { parsed: false, error: errCode(e) };
    }
    return { root: c.root, hasKey: c.hasKey, certBytes: c.certDer.length, idLen: c.id.length, ...info };
  });

  // USB: 제품은 이동식 저장소를 자동으로 훑지 않는다(npki-scan.ts). 같은 스캐너로 USB 루트를 줬을 때 읽히는지만 본다.
  const drives = removableDrives();
  const usb: Record<string, unknown>[] = [];
  for (const d of drives ?? []) {
    const dir = path.win32.join(`${d}\\`, 'NPKI');
    const has = fsSync.existsSync(dir);
    const r = has ? await scanNpki({ roots: [{ kind: 'locallow', dir }] }) : null;
    usb.push({ drive: d, hasNpki: has, certs: r?.certs.length ?? 0, withKey: r?.certs.filter((c) => c.hasKey).length ?? 0, skipped: r?.skipped ?? null });
  }
  return {
    roots: roots.map((r) => ({ kind: r.kind, exists: fsSync.existsSync(r.dir) })),
    scanMs,
    count: res.certs.length,
    skipped: res.skipped,
    access,
    certs,
    removableDrives: drives === null ? 'query_timeout' : drives.length,
    usb,
    defaultScanIncludesUsb: roots.some((r) => !/^[A-Za-z]:\\(Users|Program Files)/i.test(r.dir)),
  };
}

// ───────────────────────── 2) 키체인(Credential Manager) ─────────────────────────

/** cmdkey /list에서 이 실행의 대상(Target 줄) 수. cmdkey는 ENTERPRISE 지속성이면 지속성 줄을 출력하지 않아 지속성은 credPersist로 읽는다. */
function cmdkeyCount(marker: string): number | null {
  const out = ps('cmdkey /list', 180_000);
  if (out === null) return null;
  return out.split(/\r?\n/).filter((l) => /^\s*(Target|대상):/.test(l) && l.includes(marker)).length;
}

/** CredReadW로 일반 자격 증명의 Persist 값을 읽는다(1 SESSION, 2 LOCAL_MACHINE, 3 ENTERPRISE). 비밀 바이트는 꺼내지 않는다. */
function credPersist(target: string): string | null {
  const cs = `using System;using System.Runtime.InteropServices;public static class RdCred{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct C{public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;public long LastWritten;public int BlobSize;public IntPtr Blob;public int Persist;public int AttrCount;public IntPtr Attrs;public IntPtr Alias;public IntPtr User;}[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CredReadW(string t,int type,int f,out IntPtr c);[DllImport("advapi32.dll")]static extern void CredFree(IntPtr c);public static int P(string t){IntPtr p;if(!CredReadW(t,1,0,out p))return -Marshal.GetLastWin32Error();var c=(C)Marshal.PtrToStructure(p,typeof(C));CredFree(p);return c.Persist;}}`;
  const out = ps(`Add-Type -TypeDefinition '${cs.replace(/'/g, "''")}'; [RdCred]::P('${target.replace(/'/g, "''")}')`);
  if (out === null) return null;
  const n = Number(out.trim());
  return ({ 1: 'SESSION', 2: 'LOCAL_MACHINE', 3: 'ENTERPRISE' } as Record<number, string>)[n] ?? `error:${n}`;
}

async function keychain(): Promise<Record<string, unknown>> {
  const run = `rd-test/${randomBytes(4).toString('hex')}`;
  const store = new KeyringItemStore();
  const out: Record<string, unknown> = { service: KEYCHAIN_SERVICE, itemMaxBytes: ITEM_MAX_BYTES };
  const names: string[] = [];
  const name = (n: string) => {
    const full = `${run}/${n}`;
    names.push(full);
    return full;
  };
  try {
    // (a) 저장·읽기·삭제 왕복(크기별)
    const roundTrip: Record<string, unknown>[] = [];
    for (const size of [1, 32, 256, ITEM_MAX_BYTES]) {
      const n = name(`rt-${size}`);
      const v = new Uint8Array(randomBytes(size));
      const t0 = process.hrtime.bigint();
      await store.set(n, v);
      const setMs = ms(t0);
      const back = await store.get(n);
      const same = !!back && Buffer.compare(Buffer.from(back), Buffer.from(v)) === 0;
      const t1 = process.hrtime.bigint();
      const deleted = await store.delete(n);
      const delMs = ms(t1);
      const after = await store.get(n);
      roundTrip.push({ size, same, setMs, deleted, delMs, goneAfterDelete: after === null });
    }
    out.roundTrip = roundTrip;
    out.deleteMissing = await store.delete(name('never-set'));

    // (b) 항목 크기 상한: 앱 검사(2,560B 초과 거부)와 OS 자체 상한(CRED_MAX_CREDENTIAL_BLOB_SIZE)
    try {
      await store.set(name('over-app'), new Uint8Array(ITEM_MAX_BYTES + 1));
      out.appRejectsOver = false;
    } catch (e) {
      out.appRejectsOver = errCode(e);
    }
    // OsKeyStore.create는 앱 크기 검사 없이 바로 setSecret한다(OS 상한을 그대로 본다).
    const osLimit: Record<string, unknown> = {};
    for (const size of [ITEM_MAX_BYTES + 1, 5_120]) {
      const n = name(`over-os-${size}`);
      try {
        await new OsKeyStore().create(n, size);
        osLimit[size] = 'stored';
      } catch (e) {
        osLimit[size] = errCode(e);
      }
    }
    out.osLimit = osLimit;

    // (c) 항목 개수: 슬롯 1개 최대치(보안카드 35칸 + kek/device·kek/hello·consent) + 전역(index·settings) = 40개
    const many = 40;
    const t2 = process.hrtime.bigint();
    for (let i = 0; i < many; i++) await store.set(name(`many-${i}`), new Uint8Array(randomBytes(256)));
    out.manyWriteMs = ms(t2);
    out.cmdkeyCount = cmdkeyCount(run);
    // 지속성: 설계는 LOCAL_MACHINE(W-4, D05 §2). keyring-rs 대상 이름은 `<사용자>.<서비스>`.
    out.persist = credPersist(`${run}/many-0.${KEYCHAIN_SERVICE}`);
    let readOk = 0;
    for (let i = 0; i < many; i++) if ((await store.get(`${run}/many-${i}`))?.length === 256) readOk++;
    out.many = { written: many, readOk };

    // (d) DB 키 경로(OsKeyStore)와 길이 불일치 거부(N-30). 실제 db-key가 아닌 시험 이름.
    const ks = new OsKeyStore();
    const dbName = name('db-key');
    const before = await ks.get(dbName, 32);
    const created = await ks.create(dbName, 32);
    const again = await ks.get(dbName, 32);
    let mismatch: unknown = null;
    try {
      await ks.get(dbName, 16);
    } catch (e) {
      mismatch = errCode(e);
    }
    out.osKeyStore = { emptyFirst: before === null, readBack: !!again && Buffer.compare(Buffer.from(again), Buffer.from(created)) === 0, mismatch };

    // (e) 사람 비밀 래핑 경로: TPM 확인 → 없으면 DPAPI. 네이티브 헬퍼가 없으면 저장 거부(fail closed).
    const be = keychainBackend('win32');
    let wrap: unknown;
    try {
      await be.wrapper.wrap(new Uint8Array(32), 'slot');
      wrap = 'wrapped';
    } catch (e) {
      wrap = errCode(e);
    }
    out.backend = { tier: be.wrapper.tier, wrap, helloAvailable: await be.hello.available() };
    // 이 PC에서 DPAPI(CurrentUser) 자체가 동작하는지(시험 바이트만, KEK 아님).
    const dpapi = ps(
      "Add-Type -AssemblyName System.Security; $d=[byte[]](1..32); $e=[byte[]][char[]]'slot'; $p=[Security.Cryptography.ProtectedData]::Protect($d,$e,'CurrentUser'); $u=[Security.Cryptography.ProtectedData]::Unprotect($p,$e,'CurrentUser'); \"$($p.Length) $([Convert]::ToBase64String($u) -eq [Convert]::ToBase64String($d))\"",
    );
    out.dpapiProbe = dpapi === null ? 'timeout' : dpapi.trim();
    const tpm = ps('tpmtool getdeviceinformation 2>&1 | Select-Object -First 3; "EXIT=$LASTEXITCODE"');
    out.tpmtool = tpm === null ? 'timeout' : tpm.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } finally {
    let left = 0;
    for (const n of names) {
      await store.delete(n);
      if ((await store.get(n).catch(() => null)) !== null) left++;
    }
    out.cleanup = { attempted: names.length, left, cmdkeyAfter: cmdkeyCount(run) };
  }
  return out;
}

// ───────────────────────── 3) 전용 Chrome 프로필 ─────────────────────────

/** 이 프로필 폴더를 쓰는 chrome.exe 수(명령줄 기준). 조회 실패면 null. */
function chromeProcsFor(profileDir: string): number | null {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }", 90_000);
  if (out === null) return null;
  return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(profileDir.toLowerCase())).length;
}

function residueLeft(profileDir: string): string[] {
  return PROFILE_RESIDUE_PATHS.filter((rel) => fsSync.existsSync(path.join(profileDir, ...rel.split('/'))));
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>rd ${req.url}</title><form method="post" action="/post"><input name="q" value="x"></form><p>${req.url}</p>`);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) };
}

async function chromeCycle(exe: string, base: string, i: number, mode: 'close' | 'kill'): Promise<Record<string, unknown>> {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), `sax-rd-chrome-${i}-`));
  const row: Record<string, unknown> = { i, mode };
  try {
    await writeProfileSettings(profileDir);
    const t0 = process.hrtime.bigint();
    const chrome = await launchChrome({ executable: exe, profileDir });
    const ver = await chrome.conn.send<{ product: string }>('Browser.getVersion');
    row.cdpReadyMs = ms(t0);
    row.product = ver.product;
    row.devToolsActivePort = fsSync.existsSync(path.join(profileDir, 'DevToolsActivePort'));
    // 방문 기록·세션이 생기도록 두 페이지를 연다.
    await chrome.conn.send('Target.createTarget', { url: `${base}/a?run=${i}` });
    await sleep(1500);
    await chrome.conn.send('Target.createTarget', { url: `${base}/b?run=${i}#frag` });
    await sleep(2500);
    row.procsWhileRunning = chromeProcsFor(profileDir);
    const t1 = process.hrtime.bigint();
    if (mode === 'close') await chrome.close();
    else {
      chrome.proc.kill('SIGKILL');
      await new Promise<void>((r) => (chrome.proc.exitCode !== null ? r() : chrome.proc.once('exit', () => r())));
    }
    row.closeMs = ms(t1);
    // 금고 shutdown()과 같은 순서: 브라우저 프로세스가 끝나자마자 지운다. 이때 자식 프로세스가 남아 파일을 잡고 있으면 EBUSY/EPERM.
    row.residueBefore = residueLeft(profileDir).length;
    const t2 = process.hrtime.bigint();
    try {
      row.removed = await removeProfileResidue(profileDir);
    } catch (e) {
      row.removeError = errCode(e);
    }
    row.removeMs = ms(t2);
    row.residueAfter = residueLeft(profileDir);
    try {
      row.dumpsRemoved = await removeCrashDumps(profileDir);
    } catch (e) {
      row.dumpsError = errCode(e);
    }
    row.procsAfterExit = chromeProcsFor(profileDir);
  } catch (e) {
    row.error = errCode(e);
  } finally {
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
      row.tmpCleanup = 'ok';
    } catch (e) {
      row.tmpCleanup = errCode(e);
      await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    }
  }
  return row;
}

async function chrome(): Promise<Record<string, unknown>> {
  const exe = findInstalledChrome();
  if (!exe) return { exe: null };
  const exeKind = exe.toLowerCase().includes('(x86)') ? 'ProgramFiles(x86)' : exe.toLowerCase().startsWith(os.homedir().toLowerCase()) ? 'LOCALAPPDATA' : 'ProgramFiles';
  const srv = await startServer();
  const cycles: Record<string, unknown>[] = [];
  try {
    const n = Number(process.env.SAX_RD_CHROME_RUNS ?? 10);
    for (let i = 0; i < n; i++) cycles.push(await chromeCycle(exe, srv.url, i, 'close'));
    for (let i = 0; i < 3; i++) cycles.push(await chromeCycle(exe, srv.url, n + i, 'kill'));
  } finally {
    await srv.close();
  }
  const fails = cycles.filter((c) => c.removeError || c.error || (c.residueAfter as string[] | undefined)?.length);
  return { exeKind, cycles, summary: { runs: cycles.length, failures: fails.length, errors: fails.map((c) => c.removeError ?? c.error ?? 'residue_left') } };
}

// ───────────────────────── 4) 금고 폴더 확인 속도(ADR-041) ─────────────────────────

const shutdownChrome = (h: Harness) => h.client.rpc('browser.shutdown').catch((e: unknown) => errCode(e));

/** 실제 Windows 폴더 확인(dirGuard 기본값)으로 금고가 전용 Chrome을 띄우는 시간. 앱처럼 warmDirChecks 뒤 같은 금고에서 10회. */
async function acl(): Promise<Record<string, unknown>> {
  // 비교: 금고 readOwner와 같은 PowerShell Get-Acl 한 번(11-06: 3.4~15초)
  const getAclMs: Array<number | null> = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const out = ps('(Get-Acl -LiteralPath $env:TEMP).GetOwner([System.Security.Principal.SecurityIdentifier]).Value', 90_000);
    getAclMs.push(out === null ? null : ms(t0));
  }
  // 차가운 기동: 새 금고(새 앱 루트)에서 미리 확인 없이 바로 기동
  const cold = await startHarness();
  const coldRow: Record<string, unknown> = {};
  try {
    const t0 = process.hrtime.bigint();
    try {
      await cold.client.rpc('browser.launch');
      coldRow.ok = true;
    } catch (e) {
      coldRow.ok = false;
      coldRow.error = errCode(e);
    }
    coldRow.launchMs = ms(t0);
    await shutdownChrome(cold);
  } finally {
    await cold.close().catch(() => {});
  }
  // 앱과 같은 순서: 금고 시작 때 warmDirChecks → 기동·내리기 10회
  const h = await startHarness();
  const runs: Record<string, unknown>[] = [];
  let warm: Record<string, unknown> | undefined;
  try {
    const t0 = process.hrtime.bigint();
    await h.vault.warmDirChecks();
    const ev = h.log.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.code === 'vault.dir_check_warm');
    warm = { ms: ms(t0), ok: ev?.ok ?? null };
    for (let i = 0; i < 10; i++) {
      const from = h.log.lines.length;
      const row: Record<string, unknown> = { i };
      const t1 = process.hrtime.bigint();
      try {
        await h.client.rpc('browser.launch');
        row.ok = true;
      } catch (e) {
        row.ok = false;
        row.error = errCode(e);
      }
      row.launchMs = ms(t1);
      const t2 = process.hrtime.bigint();
      const sd = await shutdownChrome(h);
      row.shutdownMs = ms(t2);
      if (typeof sd === 'string') row.shutdownError = sd;
      const codes = h.log.lines.slice(from).map((l) => String((JSON.parse(l) as Record<string, unknown>).code));
      const problems = codes.filter((c) => /dir_problem|not_private|timed_out|busy/.test(c));
      if (problems.length) row.events = problems;
      runs.push(row);
    }
  } finally {
    await h.close().catch(() => {});
  }
  const okMs = runs.filter((r) => r.ok).map((r) => r.launchMs as number);
  return { getAclMs, cold: coldRow, warm, runs, summary: { ok: okMs.length, fail: runs.length - okMs.length, minMs: Math.min(...okMs), maxMs: Math.max(...okMs) } };
}

// ───────────────────────── 5) 다운로드 중 강제 종료 → 잔존물·staging(#178·#209) ─────────────────────────

/** staging 파일을 종류별 개수로만(이름 없음). */
async function stagingKinds(dir: string): Promise<Record<string, number>> {
  const out = { pdf: 0, crdownload: 0, guid: 0, other: 0 };
  for (const n of await fs.readdir(dir).catch(() => [] as string[])) {
    if (/^[0-9a-f]{32}\.pdf$/.test(n)) out.pdf++;
    else if (/\.crdownload$/i.test(n)) out.crdownload++;
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)) out.guid++;
    else out.other++;
  }
  return out;
}

/** /doc의 #slow는 PDF 첨부를 16KB씩 100 ms마다 보낸다(4MB, 약 25초): 강제 종료 때 받는 중이다. */
async function startSlowSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    if (req.url === '/doc') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>doc</title><a id="slow" href="/slow.pdf">pdf</a>');
      return;
    }
    if (req.url === '/slow.pdf') {
      const total = 4 * 1024 * 1024;
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(total), 'content-disposition': 'attachment; filename="rd-slow.pdf"' });
      let sent = 0;
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      chunk.write('%PDF-1.4\n');
      const t = setInterval(() => {
        if (sent >= total) {
          clearInterval(t);
          res.end();
          return;
        }
        res.write(chunk);
        sent += chunk.length;
      }, 100);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise((r) => srv.close(() => r())) };
}

const codeCounts = (lines: string[]) => {
  const out: Record<string, number> = {};
  for (const l of lines) {
    const e = JSON.parse(l) as Record<string, unknown>;
    const c = String(e.code);
    if (!/chrome_closed|residue|dump|staging_swept|download_|pdf_saved/.test(c)) continue;
    // count 필드가 있으면 그 값을 더한다(지운 개수·못 지운 개수)
    out[c] = (out[c] ?? 0) + (typeof e.count === 'number' ? e.count : typeof e.removed === 'number' ? e.removed : 1);
  }
  return out;
};

async function kill(): Promise<Record<string, unknown>> {
  const site = await startSlowSite();
  const h = await startHarness();
  const cycles: Record<string, unknown>[] = [];
  const final: Record<string, unknown> = {};
  try {
    for (let i = 0; i < 10; i++) {
      const from = h.log.lines.length;
      const row: Record<string, unknown> = { i };
      try {
        await h.client.rpc('browser.launch');
        row.stagingAtLaunch = await stagingKinds(h.paths.staging);
        const eng = new RawEngine(h.client);
        const { sessionId, targetId } = await eng.attachRunPage();
        await eng.navigate(sessionId, `${site.origin}/doc`);
        row.armed = ((await h.client.rpc('download.arm', { runId: 'r1', targetId })) as { armed?: boolean }).armed === true;
        await eng.evaluate(sessionId, `document.getElementById('slow').click()`);
        await sleep(2500);
        row.stagingBeforeKill = await stagingKinds(h.paths.staging);
        const pid = h.vault.chromePid;
        if (pid) process.kill(pid, 'SIGKILL');
        for (const until = Date.now() + 15_000; Date.now() < until && !h.log.lines.slice(from).some((l) => l.includes('vault.chrome_closed')); ) await sleep(100);
        const t0 = process.hrtime.bigint();
        const sd = await shutdownChrome(h);
        row.shutdownMs = ms(t0);
        if (typeof sd === 'string') row.shutdownError = sd;
        row.residueLeft = residueLeft(h.paths.chromeProfile).length;
        await sleep(3000);
        row.stagingAfter = await stagingKinds(h.paths.staging);
        row.chromeProcsLeft = chromeProcsFor(h.paths.chromeProfile);
        row.events = codeCounts(h.log.lines.slice(from));
      } catch (e) {
        row.error = errCode(e);
        await shutdownChrome(h);
      }
      cycles.push(row);
    }
    // 마지막: 다시 기동만 했을 때 staging이 정리되는지, 무장 없는 다운로드(정리 계기)가 오면 정리되는지
    const from = h.log.lines.length;
    await h.client.rpc('browser.launch');
    await sleep(3000);
    final.afterRelaunch = await stagingKinds(h.paths.staging);
    const eng = new RawEngine(h.client);
    const { sessionId } = await eng.attachRunPage();
    await eng.navigate(sessionId, `${site.origin}/doc`);
    await eng.evaluate(sessionId, `document.getElementById('slow').click()`);
    await sleep(5000);
    final.afterUnarmedDownload = await stagingKinds(h.paths.staging);
    await shutdownChrome(h);
    final.residueLeft = residueLeft(h.paths.chromeProfile).length;
    final.events = codeCounts(h.log.lines.slice(from));
  } finally {
    await h.close().catch(() => {});
    await site.close();
  }
  const busy = cycles.reduce((n, c) => n + Number((c.events as Record<string, number> | undefined)?.['vault.chrome_residue_busy'] ?? 0) + Number((c.events as Record<string, number> | undefined)?.['vault.chrome_dump_busy'] ?? 0), 0);
  const leftover = cycles.filter((c) => {
    const s = c.stagingAfter as Record<string, number> | undefined;
    return s && s.crdownload + s.guid + s.other > 0;
  }).length;
  return { cycles, final, summary: { runs: cycles.length, errors: cycles.filter((c) => c.error).length, residueLeftCycles: cycles.filter((c) => Number(c.residueLeft) > 0).length, busyEvents: busy, stagingLeftoverCycles: leftover } };
}

// ───────────────────────── 실행 ─────────────────────────

if (process.platform !== 'win32') {
  console.error('Windows 전용 점검이다.');
  process.exit(1);
}
const what = process.argv[2] ?? 'all';
const env = { node: process.version, os: `${os.version()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 2 ** 30 * 10) / 10 };
const jobs: Record<string, () => Promise<Record<string, unknown>>> = { npki, keychain, chrome, acl, kill };
for (const [k, fn] of Object.entries(jobs)) {
  if (what !== 'all' && what !== k) continue;
  const t0 = process.hrtime.bigint();
  const result = { env, ...(await fn()), elapsedMs: ms(t0) };
  const file = await writeMeasure(`${k}.json`, result);
  console.log(`${k}: ${file}`);
  console.log(JSON.stringify(result, null, 2));
}
