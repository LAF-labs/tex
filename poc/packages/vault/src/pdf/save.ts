// 금고 PDF 저장(D05 §3.3 다운로드·인쇄 경로, ADR-025, 팀장 결정 2026-11-06). 엔진 save_pdf 핸들러가 부른다.
// 엔진의 Page.printToPDF·Page/Browser.setDownloadBehavior는 중계가 계속 거부한다(RELAY_DENIED_METHODS). 금고가 자기 세션에서
// 인쇄하거나, 무장된 다운로드 1건만 staging에 받는다. 검사(크기·PDF 형식)를 통과한 파일은 무작위 이름(사용자 전용 권한)으로
// staging에 두고, 엔진에는 fileId만 준다(바이트·원래 파일 이름·URL 없음). 보관함 이동은 엔진의 기존 문서 가져오기 경로를 따른다.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EventLog } from '@sax/platform';
import {
  DOWNLOAD_ARM_TTL_MS, PDF_MAX_BYTES, type DownloadArmParams, type DownloadArmResult, type DownloadFailReason, type PdfPrintParams, type PdfPrintResult,
} from '../protocol.ts';
import type { TargetState } from '../relay/relay.ts';

type Json = Record<string, unknown>;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Chrome 다운로드 guid(allowAndName이면 staging의 파일 이름이 된다). 경로로 쓰기 전에 모양을 확인한다. */
const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** fileId: 128비트 무작위 hex. staging 파일 이름은 `<fileId>.pdf`. */
export const PDF_FILE_ID_RE = /^[0-9a-f]{32}$/;
/** IO.read 한 번의 크기. */
const IO_CHUNK = 1024 * 1024;

/** staging 안 fileId의 파일 경로(엔진 문서 가져오기도 이것으로 찾는다). 모양이 틀린 id는 거부한다. */
export function stagedPdfPath(staging: string, fileId: string): string {
  if (!PDF_FILE_ID_RE.test(fileId)) throw new Error('bad_file_id');
  return path.join(staging, `${fileId}.pdf`);
}

/**
 * PDF 형식 검사(MIME은 내용으로 정한다: 서버 Content-Type·파일 이름은 믿지 않는다).
 * 첫 바이트가 `%PDF-1.`·`%PDF-2.`이고, 끝 1024바이트 안에 `%%EOF`가 있어야 한다(잘린 파일 거부).
 */
export function checkPdfBytes(bytes: Uint8Array, maxBytes = PDF_MAX_BYTES): 'ok' | 'empty' | 'too_large' | 'not_pdf' {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > maxBytes) return 'too_large';
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (!/^%PDF-[12]\.\d/.test(head)) return 'not_pdf';
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1');
  if (!tail.includes('%%EOF')) return 'not_pdf';
  return 'ok';
}

export interface PdfSaverOptions {
  staging: string;
  log: EventLog;
  /** 금고 세션 CDP 명령(엔진 중계를 거치지 않는다). */
  send: <T = Json>(method: string, params: Json, sessionId?: string) => Promise<T>;
  /** 엔진에 노출된 타깃만. */
  exposed: (targetId: string) => TargetState | undefined;
  emit: (name: 'download.completed' | 'download.failed', data: Record<string, unknown>) => void;
  /** 시험 전용. 기본 PDF_MAX_BYTES. */
  maxBytes?: number;
  /** 시험 전용. 기본 DOWNLOAD_ARM_TTL_MS. */
  armTtlMs?: number;
}

interface Armed {
  runId: string;
  targetId: string;
  timer: NodeJS.Timeout;
}

interface Active {
  targetId: string;
  tooLarge: boolean;
}

export class PdfSaver {
  private readonly o: PdfSaverOptions;
  private readonly max: number;
  private armed: Armed | null = null;
  private readonly active = new Map<string, Active>();
  /** 무장 없이 시작돼 취소한 다운로드. 끝 이벤트(canceled·completed)가 오면 남은 파일을 다시 지운다(Windows는 취소 직후 Chrome이 .crdownload를 만들거나 잡고 있다). */
  private readonly rejected = new Set<string>();
  private printing = false;
  private closed = false;

  constructor(o: PdfSaverOptions) {
    this.o = o;
    this.max = o.maxBytes ?? PDF_MAX_BYTES;
  }

  /** Chrome 브라우저 수준 다운로드 설정: staging에 guid 이름으로만 받고 진행 이벤트를 켠다(엔진은 이 설정을 바꿀 수 없다). */
  async init(): Promise<void> {
    await this.ensureStaging();
    await this.o.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.o.staging, eventsEnabled: true });
  }

  shutdown(): void {
    this.closed = true;
    this.rejected.clear();
    if (this.armed) clearTimeout(this.armed.timer);
    this.armed = null;
    this.active.clear();
  }

  // ───────────────────────── 인쇄(strategy print) ─────────────────────────

  async print(p: Partial<PdfPrintParams>): Promise<PdfPrintResult> {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return this.refuse('bad_params');
    if (p.landscape !== undefined && typeof p.landscape !== 'boolean') return this.refuse('bad_params');
    const t = this.o.exposed(p.targetId);
    if (!t) return this.refuse('target_not_exposed');
    // 비밀 창이 열려 있거나(활성) 값이 남아 있을 수 있는(오염) 타깃은 찍지 않는다(D05 §3.5 ①: 화면 캡처 거부와 같은 규칙).
    if (t.win) return this.refuse('secret_window_open');
    if (this.printing) return this.refuse('busy');
    this.printing = true;
    try {
      let bytes: Uint8Array | 'too_large';
      try {
        bytes = await this.printStream(t.vaultSession, p.landscape === true);
      } catch {
        return this.refuse('print_failed');
      }
      if (bytes === 'too_large') return this.refuse('too_large');
      // 인쇄하는 동안 비밀 창이 열렸으면 버린다.
      if (t.win) return this.refuse('secret_window_open');
      const verdict = checkPdfBytes(bytes, this.max);
      if (verdict !== 'ok') return this.refuse(verdict === 'empty' ? 'not_pdf' : verdict);
      const fileId = await this.writeStaged(bytes);
      this.o.log.event('vault.pdf_saved', { via: 'print', bytes: bytes.length });
      this.o.emit('download.completed', { fileId });
      return { ok: true, fileId };
    } finally {
      this.printing = false;
    }
  }

  /** printToPDF를 스트림으로 받아 상한을 넘는 순간 끊는다(큰 base64 응답을 통째로 받지 않는다). */
  private async printStream(sid: string, landscape: boolean): Promise<Uint8Array | 'too_large'> {
    const { stream } = await this.o.send<{ stream?: string }>('Page.printToPDF', {
      printBackground: true, preferCSSPageSize: true, landscape, transferMode: 'ReturnAsStream',
    }, sid);
    if (typeof stream !== 'string') throw new Error('no stream');
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for (;;) {
        const r = await this.o.send<{ data: string; eof: boolean; base64Encoded?: boolean }>('IO.read', { handle: stream, size: IO_CHUNK }, sid);
        const c = Buffer.from(r.data ?? '', r.base64Encoded ? 'base64' : 'latin1');
        n += c.length;
        if (n > this.max) return 'too_large';
        chunks.push(c);
        if (r.eof) break;
      }
    } finally {
      await this.o.send('IO.close', { handle: stream }, sid).catch(() => {});
    }
    return new Uint8Array(Buffer.concat(chunks, n));
  }

  // ───────────────────────── 다운로드(strategy original) ─────────────────────────

  /** 다음 다운로드 1건을 받는다(단일 사용, armTtlMs 안). 무장 없이 시작된 다운로드는 취소하고 지운다. */
  arm(p: Partial<DownloadArmParams>): DownloadArmResult {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return this.armRefuse('bad_params');
    if (!this.o.exposed(p.targetId)) return this.armRefuse('target_not_exposed');
    if (this.armed || this.active.size) return this.armRefuse('already_armed');
    const timer = setTimeout(() => {
      if (this.armed?.timer !== timer) return;
      this.armed = null;
      this.fail('expired');
    }, this.o.armTtlMs ?? DOWNLOAD_ARM_TTL_MS);
    timer.unref?.();
    this.armed = { runId: p.runId, targetId: p.targetId, timer };
    this.o.log.event('vault.download_armed');
    return { armed: true };
  }

  disarm(): void {
    if (this.armed) clearTimeout(this.armed.timer);
    this.armed = null;
  }

  /** 중계가 넘기는 브라우저 수준 Browser.download* 이벤트. */
  async onBrowserEvent(method: string, p: Json): Promise<void> {
    if (this.closed) return;
    const guid = typeof p.guid === 'string' && GUID_RE.test(p.guid) ? p.guid : null;
    if (!guid) return;
    if (method === 'Browser.downloadWillBegin') {
      const a = this.armed;
      const ok = a !== null && (await this.frameInTarget(a.targetId, String(p.frameId ?? '')));
      if (!ok || this.armed !== a || !a) {
        // 무장 없는 다운로드·다른 타깃의 다운로드는 받지 않는다(원래 파일 이름·URL은 로그에 넣지 않는다).
        this.o.log.event('vault.download_unexpected');
        this.rejected.add(guid);
        await this.cancel(guid);
        return;
      }
      clearTimeout(a.timer);
      this.armed = null;
      this.active.set(guid, { targetId: a.targetId, tooLarge: false });
      return;
    }
    if (method !== 'Browser.downloadProgress') return;
    if (this.rejected.has(guid)) {
      if (p.state === 'canceled' || p.state === 'completed') {
        this.rejected.delete(guid);
        await this.removeGuidFiles(guid);
      }
      return;
    }
    const d = this.active.get(guid);
    if (!d) return;
    const state = p.state;
    if (state === 'inProgress') {
      const total = Number(p.totalBytes ?? 0);
      const got = Number(p.receivedBytes ?? 0);
      if (!d.tooLarge && (total > this.max || got > this.max)) {
        d.tooLarge = true;
        await this.o.send('Browser.cancelDownload', { guid }).catch(() => {});
      }
      return;
    }
    if (state === 'canceled') {
      this.active.delete(guid);
      await this.removeGuidFiles(guid);
      this.fail(d.tooLarge ? 'too_large' : 'canceled');
      return;
    }
    if (state === 'completed') {
      this.active.delete(guid);
      if (d.tooLarge) {
        await this.removeGuidFiles(guid);
        this.fail('too_large');
        return;
      }
      await this.finishDownload(guid);
    }
  }

  private async finishDownload(guid: string): Promise<void> {
    const src = path.join(this.o.staging, guid);
    let bytes: Uint8Array;
    try {
      // 링크·특수 파일·하드링크는 받지 않는다(Chrome이 쓴 일반 파일만).
      const st = await fs.lstat(src);
      if (!st.isFile() || st.nlink !== 1) throw new Error('not_file');
      if (st.size > this.max) {
        await this.removeGuidFiles(guid);
        this.fail('too_large');
        return;
      }
      bytes = new Uint8Array(await fs.readFile(src));
    } catch {
      await this.removeGuidFiles(guid);
      this.fail('unreadable');
      return;
    }
    await this.removeGuidFiles(guid);
    const verdict = checkPdfBytes(bytes, this.max);
    if (verdict !== 'ok') {
      this.fail(verdict === 'empty' ? 'not_pdf' : verdict);
      return;
    }
    const fileId = await this.writeStaged(bytes);
    this.o.log.event('vault.pdf_saved', { via: 'download', bytes: bytes.length });
    this.o.emit('download.completed', { fileId });
  }

  /** 다운로드 frameId가 그 타깃의 프레임인가(메인 프레임 = 타깃 ID, 하위 프레임은 금고 세션 프레임 트리로 확인). */
  private async frameInTarget(targetId: string, frameId: string): Promise<boolean> {
    const t = this.o.exposed(targetId);
    if (!t || !frameId) return false;
    if (frameId === t.targetId || frameId === t.mainFrameId) return true;
    const tree = await this.o.send<{ frameTree: Json }>('Page.getFrameTree', {}, t.vaultSession).catch(() => null);
    const walk = (n: Json | undefined): boolean => {
      if (!n) return false;
      if ((n.frame as Json | undefined)?.id === frameId) return true;
      return ((n.childFrames as Json[] | undefined) ?? []).some(walk);
    };
    return walk(tree?.frameTree);
  }

  private async cancel(guid: string): Promise<void> {
    await this.o.send('Browser.cancelDownload', { guid }).catch(() => {});
    await this.removeGuidFiles(guid);
  }

  private async removeGuidFiles(guid: string): Promise<void> {
    // Windows는 Chrome이 막 놓은 파일을 잠깐 잡고 있어 EPERM·EBUSY가 난다. 짧게 다시 시도한다(maxRetries는 recursive일 때만 듣는다, 없으면 force로 통과).
    for (const name of [guid, `${guid}.crdownload`]) await fs.rm(path.join(this.o.staging, name), { force: true, recursive: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 50 }).catch(() => {});
  }

  // ───────────────────────── staging ─────────────────────────

  private async ensureStaging(): Promise<void> {
    await fs.mkdir(this.o.staging, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(this.o.staging);
    if (!st.isDirectory()) throw new Error('staging not a directory');
  }

  /** 무작위 이름으로 새로 만든다(덮어쓰지 않는다). POSIX는 0600, Windows는 앱 루트의 소유자 전용 DACL을 물려받는다(D07 §1). */
  private async writeStaged(bytes: Uint8Array): Promise<string> {
    await this.ensureStaging();
    const fileId = randomBytes(16).toString('hex');
    const file = stagedPdfPath(this.o.staging, fileId);
    const fh = await fs.open(file, 'wx', 0o600);
    try {
      await fh.writeFile(bytes);
      if (process.platform !== 'win32') await fh.chmod(0o600);
    } finally {
      await fh.close();
    }
    return fileId;
  }

  private refuse(reason: Exclude<PdfPrintResult, { ok: true }>['reason']): PdfPrintResult {
    this.o.log.event('vault.pdf_refused', { via: 'print', reason });
    return { ok: false, reason };
  }

  private armRefuse(reason: Exclude<DownloadArmResult, { armed: true }>['reason']): DownloadArmResult {
    this.o.log.event('vault.download_arm_refused', { reason });
    return { armed: false, reason };
  }

  private fail(reason: DownloadFailReason): void {
    this.o.log.event('vault.pdf_refused', { via: 'download', reason });
    this.o.emit('download.failed', { reason });
  }
}
