// tests/fixtures/core의 골든 패키지(H-01 v2.1 + 조회 패키지 2개)를 읽는 도우미. 반례는 이것을 복제해 한 군데만 바꾼다.
import fs from 'node:fs';
import { BundleCatalog } from '@sax/model';
import type { BundleOutcomes, PackageFiles } from '@sax/engine/core';

const DIR = new URL('./fixtures/core/', import.meta.url);
const read = (p: string) => JSON.parse(fs.readFileSync(new URL(p, DIR), 'utf8')) as never;

export function loadPkg(dir: string): PackageFiles {
  return { manifest: read(`${dir}/manifest.json`), playbook: read(`${dir}/playbook.json`), selectors: read(`${dir}/selectors.json`), strings: read(`${dir}/strings.ko.json`) };
}

export const h01 = (): PackageFiles => structuredClone(loadPkg('h01'));
export const lookups = (): Map<string, PackageFiles> =>
  new Map(['hometax.invoice.lookup', 'hometax.invoice.email_status'].map((id) => [id, structuredClone(loadPkg(`lookups/${id}`))]));

export function bundleOutcomes(): Map<string, BundleOutcomes> {
  return new Map(BundleCatalog.load().list().map((b) => [b.wireId, { outcomes: b.def.outcomes.map((o) => o.name), reserved: b.def.reservedOutcomes }]));
}
