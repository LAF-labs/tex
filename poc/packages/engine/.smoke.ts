import { chromium } from 'playwright-core';
import { startHometaxFake } from '../../tests/hometax-fake.ts';
const fx = await startHometaxFake({ renderDelayMs: 300 });
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
await p.goto(fx.origin + '/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&menuCd=index3');
await p.waitForTimeout(800);
console.log(await p.locator('#mf_txppWframe_anchor13').ariaSnapshot());
await b.close(); await fx.close();
