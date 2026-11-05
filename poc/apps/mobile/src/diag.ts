// SP-1 기기 진단: 키 항목 정책과 앱 데이터 파일의 보호 등급·백업 제외를 보고한다. 값·키·사진 내용은 넣지 않는다.
import { Directory, File } from 'expo-file-system';
import { keyringPolicy } from './keyring';
import { ROOT, inspect } from './storage/files';

export interface Sp1Report {
  keychain: ReturnType<typeof keyringPolicy>;
  files: { path: string; excludedFromBackup: boolean; protection: string }[];
  ok: boolean;
}

export async function sp1Report(): Promise<Sp1Report> {
  const keychain = keyringPolicy();
  const files: Sp1Report['files'] = [];
  const visit = async (d: Directory, rel: string) => {
    const me = await inspect(d.uri);
    files.push({ path: `${rel}/`, excludedFromBackup: !!me?.excludedFromBackup, protection: me?.protection ?? 'unknown' });
    for (const c of d.list()) {
      if (c instanceof Directory) await visit(c, `${rel}/${c.name}`);
      else if (c instanceof File) {
        const r = await inspect(c.uri);
        files.push({ path: `${rel}/${c.name.replace(/^[0-9A-Z]{26}/, '<id>')}`, excludedFromBackup: !!r?.excludedFromBackup, protection: r?.protection ?? 'unknown' });
      }
    }
  };
  if (ROOT.exists) await visit(ROOT, 'sax');
  const fileOk = files.every((f) => f.excludedFromBackup && (f.protection === 'NSFileProtectionComplete' || f.protection === 'app_private' || f.path.endsWith('/')));
  const keyOk = keychain.accessible.endsWith('THIS_DEVICE_ONLY');
  return { keychain, files, ok: fileOk && keyOk };
}
