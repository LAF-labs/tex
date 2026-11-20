#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['manifest.json', 'playbook.json', 'selectors.json', 'strings.ko.json'];
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const defaultApp = () => {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? '', 'SovereignAX');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SovereignAX');
  return path.join(os.homedir(), '.local', 'share', 'SovereignAX');
};
const ID = opt('--id') ?? 'hometax.invoice.issue';
if (!/^[a-z0-9_.]{1,80}$/.test(ID)) throw new Error(`id 모양이 틀림: ${ID}`);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.resolve(opt('--from') ?? path.join(repo, 'packages', 'engine', 'playbooks', ID));
const to = path.join(path.resolve(opt('--app') ?? defaultApp()), 'rehearsal-packages', ID);

if (args.includes('--remove')) {
  fs.rmSync(to, { recursive: true, force: true });
  console.log(`removed ${to}`);
  process.exit(0);
}
for (const f of FILES) if (!fs.existsSync(path.join(from, f))) throw new Error(`없음: ${path.join(from, f)}`);
fs.mkdirSync(to, { recursive: true, mode: 0o700 });
for (const f of FILES) {
  JSON.parse(fs.readFileSync(path.join(from, f), 'utf8'));
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
const m = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8'));
console.log(`copied ${m.id} ${m.version} → ${to}`);
