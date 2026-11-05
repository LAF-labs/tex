// 다운로드 무결성(ADR-028 결정 2, D11 §4). electron-updater도 sha512를 보지만(2차 방어) 설치 직전에 우리가 검증한 매니페스트 값으로 한 번 더 본다.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fail, UpdateError, type ReleaseFile, type UpdateCode } from './manifest.ts';
import type { VerifiedRelease } from './verify.ts';

const eqB64 = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  return x.length === 64 && y.length === 64 && timingSafeEqual(x, y);
};

/** 메모리에 있는 바이트 검사(시험·작은 파일용). 크기 → sha512 순 */
export function checkBytes(bytes: Uint8Array, expected: ReleaseFile): void {
  if (bytes.byteLength !== expected.size) fail('update.size_mismatch');
  if (!eqB64(createHash('sha512').update(bytes).digest('base64'), expected.sha512)) fail('update.digest_mismatch');
}

/** 받은 설치본 파일 검사. 크기를 먼저 보고(잘린·부푼 파일은 해시 전에 거른다) 스트림으로 sha512를 잰다 */
export async function verifyDownloadedFile(filePath: string, expected: ReleaseFile): Promise<{ ok: true } | { ok: false; code: UpdateCode }> {
  try {
    const st = await stat(filePath);
    if (!st.isFile() || st.size !== expected.size) fail('update.size_mismatch');
    const h = createHash('sha512');
    let n = 0;
    for await (const chunk of createReadStream(filePath)) {
      n += (chunk as Buffer).byteLength;
      if (n > expected.size) fail('update.size_mismatch');
      h.update(chunk as Buffer);
    }
    if (n !== expected.size) fail('update.size_mismatch');
    if (!eqB64(h.digest('base64'), expected.sha512)) fail('update.digest_mismatch');
    return { ok: true };
  } catch (e) {
    if (e instanceof UpdateError) return { ok: false, code: e.code };
    // 읽지 못한 파일은 검증 실패로 본다(설치하지 않는다)
    return { ok: false, code: 'update.digest_mismatch' };
  }
}

/** electron-updater UpdateInfo 가운데 우리가 대조하는 부분(electron-updater 6.x 모양) */
export interface FeedInfo {
  version: string;
  files: ReadonlyArray<{ url: string; sha512: string; size?: number }>;
  path?: string;
  sha512?: string;
}

/**
 * electron-updater가 latest.yml에서 읽은 값이 우리가 검증한 매니페스트와 같은가(ADR-028 결정 2: 검증한 sha512만 넘긴다).
 * 버전이 같고, 모든 파일이 매니페스트에 같은 sha512·크기로 있고, path·sha512가 설치본(files[0])이어야 한다. 아니면 다운로드하지 않는다.
 */
export function matchFeed(release: VerifiedRelease, info: FeedInfo): { ok: true } | { ok: false; code: 'update.feed_mismatch' } {
  const m = release.manifest;
  const bad = { ok: false, code: 'update.feed_mismatch' } as const;
  if (info.version !== m.version || info.files.length !== m.files.length) return bad;
  const byUrl = new Map(m.files.map((f) => [f.url, f]));
  for (const f of info.files) {
    const want = byUrl.get(f.url);
    if (!want || f.sha512 !== want.sha512 || (f.size !== undefined && f.size !== want.size)) return bad;
  }
  const main = m.files[0]!;
  if (info.path !== undefined && info.path !== main.url) return bad;
  if (info.sha512 !== undefined && info.sha512 !== main.sha512) return bad;
  return { ok: true };
}
