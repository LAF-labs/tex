// 폰 연결 QR 인코더(remote-qr.ts, qrcode-generator 1.4.4 고정): 만든 SVG data URL을 jsQR로 다시 읽어 원문과 같은지 본다(팀장 결정 2026-11-06).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { DesktopPairing, b64 } from '@sax/remote';
import { QR_DATA_URL_PREFIX, qrSvgDataUrl } from '../apps/desktop/src/remote-qr.ts';
import { decodeQrDataUrl, svgOf } from './remote-qr-decode.ts';
import { softDesktopKeys } from './remote-dev-stack.ts';

const pkg = (p: string) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

describe('폰 연결 QR: main SVG → data URL 이미지 → 다시 읽기', () => {
  it('실제 페어링 QR 글자를 SVG data URL로 만들고 jsQR로 다시 읽으면 같다', () => {
    const keys = softDesktopKeys();
    const p = new DesktopPairing({ keys, deviceList: { entries: [] } as never, relayHost: 'relay.sax.test', enrollPhone: async () => {}, publishDeviceList: async () => {}, registerMailbox: async () => {}, accountClaim: async () => b64(new Uint8Array(1)) });
    const text = p.offer().qr;
    const url = qrSvgDataUrl(text);
    assert.ok(url.startsWith(QR_DATA_URL_PREFIX));
    assert.equal(decodeQrDataUrl(url), text);
  });

  it('짧은 글자·긴 글자(300자)도 다시 읽힌다', () => {
    for (const t of ['sax:1', 'x'.repeat(40) + '-_.~' + 'A1'.repeat(128)]) assert.equal(decodeQrDataUrl(qrSvgDataUrl(t)), t);
  });

  it('SVG에는 칸(rect·path)만 있다: 스크립트·외부 참조·원문 글자 없음', () => {
    const text = 'sax1.psk-should-not-appear-as-text';
    const svg = svgOf(qrSvgDataUrl(text));
    assert.ok(!svg.includes(text));
    assert.doesNotMatch(svg, /<script|foreignObject|href|on\w+=|<image|<style/i);
    assert.deepEqual([...new Set([...svg.matchAll(/<(\w+)/g)].map((m) => m[1]))].sort(), ['path', 'rect', 'svg']);
  });

  it('ASCII 밖의 글자·빈 글자는 받지 않는다', () => {
    for (const t of ['', '폰', 'a\nb']) assert.throws(() => qrSvgDataUrl(t), /pair\.qr_text/);
  });

  it('의존성: qrcode-generator는 apps/desktop dependencies에 정확한 1.4.4, jsQR은 devDependencies에만', () => {
    const d = pkg('../apps/desktop/package.json');
    assert.equal(d.dependencies?.['qrcode-generator'], '1.4.4');
    assert.equal(d.devDependencies?.jsqr, '1.4.0');
    assert.equal(d.dependencies?.jsqr, undefined);
    const root = pkg('../package.json');
    assert.equal(root.dependencies?.['qrcode-generator'] ?? root.devDependencies?.['qrcode-generator'], undefined);
    for (const p of ['remote', 'net', 'vault']) assert.equal(pkg(`../packages/${p}/package.json`).dependencies?.['qrcode-generator'], undefined, p);
  });

  it('라이선스 고지 목록에 qrcode-generator 1.4.4(MIT) 원문', () => {
    const n = fs.readFileSync(new URL('../apps/desktop/static/third-party-notices.txt', import.meta.url), 'utf8');
    assert.match(n, /qrcode-generator 1\.4\.4/);
    assert.match(n, /Copyright \(c\) 2009 Kazuhiko Arase/);
    assert.match(n, /Permission is hereby granted, free of charge/);
  });
});
