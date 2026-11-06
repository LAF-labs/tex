// Windows 실기기 점검(수동 실행, Phase 1 WIN-REALDEVICE). 결과는 reports/WIN-REALDEVICE.md에 옮긴다.
// 실행: node --conditions=development tests/win-realdevice.ts <npki|keychain|chrome|all>
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
  npkiRoots,
  removeCrashDumps,
  removeProfileResidue,
  scanNpki,
  writeProfileSettings,
} from '@sax/vault';
import { writeMeasure } from './measure-out.ts';

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
  const t0 = process.hrtime.bigint();
  const res = await scanNpki();
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

// ───────────────────────── 실행 ─────────────────────────

if (process.platform !== 'win32') {
  console.error('Windows 전용 점검이다.');
  process.exit(1);
}
const what = process.argv[2] ?? 'all';
const env = { node: process.version, os: `${os.version()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 2 ** 30 * 10) / 10 };
const jobs: Record<string, () => Promise<Record<string, unknown>>> = { npki, keychain, chrome };
for (const [k, fn] of Object.entries(jobs)) {
  if (what !== 'all' && what !== k) continue;
  const t0 = process.hrtime.bigint();
  const result = { env, ...(await fn()), elapsedMs: ms(t0) };
  const file = await writeMeasure(`${k}.json`, result);
  console.log(`${k}: ${file}`);
  console.log(JSON.stringify(result, null, 2));
}
