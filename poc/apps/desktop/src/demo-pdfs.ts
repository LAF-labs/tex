// 시연용 가상 서류 PDF를 만든다(문서함 [가져오기] 시연용, 오늘 기준 날짜). 실행: pnpm demo:pdfs → ~/Desktop/소버린AX-시연서류/.
// 데모 사업장(가나다컴퍼니·가상 번호) 서류라 대상 일치로 들어간다. 이미 있으면 덮어쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { htmlToPdf } from './demo-seed.ts';
import { DEMO_PROFILE } from './fixture-mode.ts';
import { ymd } from './shell-mock.ts';
import { demoCerts } from './synthetic-certs.ts';

app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? path.join(app.getPath('desktop'), '소버린AX-시연서류');
  await fs.mkdir(out, { recursive: true });
  for (const d of demoCerts(ymd(new Date()), { name: DEMO_PROFILE.displayName, rep: DEMO_PROFILE.repName, bizNo: DEMO_PROFILE.bizNo })) {
    await fs.writeFile(path.join(out, d.file), await htmlToPdf(d.html));
  }
  console.log(`시연 서류: ${out}`);
  app.quit();
}).catch((e: unknown) => {
  console.error('demo-pdfs failed:', (e as Error).message);
  app.exit(1);
});
