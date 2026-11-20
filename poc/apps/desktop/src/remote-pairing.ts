import { b64, b64url, DesktopPairing, SAS_MAX_TRIES, type DesktopKeys, type DesktopPairResult, type Link, type RelayClient } from '@sax/remote';
import type { DeviceSession } from './remote-account.ts';
import type { AccountClient, RelayHttpClient } from './remote-ports.ts';

type QrImage = (text: string) => string;

export interface PairView {
  step: 'idle' | 'opening' | 'waiting_phone' | 'awaiting_sas' | 'checking' | 'paired' | 'failed';
  qr: string | null;
  expiresAt: number | null;
  phoneName: string | null;
  triesLeft: number | null;
  error: string | null;
}

interface PairingHostOptions {
  account: AccountClient;
  relayHttp: RelayHttpClient;
  relay: RelayClient;
  relayHost: string;
  device: DeviceSession;
  keys: () => Promise<DesktopKeys>;
  qr: QrImage;
  desktopName?: string;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number>) => void;
  onPaired?: (r: DesktopPairResult) => void;
  onView?: (v: PairView) => void;
  closeAfterMs?: number;
}

const codeOf = (e: unknown, fallback: string): string => {
  const c = (e as { code?: unknown } | null)?.code;
  const m = (e as Error | null)?.message;
  if (typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c)) return c;
  if (typeof m === 'string' && /^[a-z_]+\.[a-z_]+$/.test(m)) return m;
  return fallback;
};

const IDLE: PairView = { step: 'idle', qr: null, expiresAt: null, phoneName: null, triesLeft: null, error: null };

export class PairingHost {
  #o: PairingHostOptions;
  #now: () => number;
  #log: NonNullable<PairingHostOptions['log']>;
  #view: PairView = IDLE;
  #p: DesktopPairing | null = null;
  #link: Link | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #mbx: { id: Uint8Array; tokWrite: Uint8Array } | null = null;
  #stepError: string | null = null;
  #gen = 0;

  constructor(o: PairingHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  view(): PairView {
    return this.#view;
  }

  #set(v: Partial<PairView>) {
    this.#view = { ...this.#view, ...v };
    this.#o.onView?.(this.#view);
  }

  async start(): Promise<PairView> {
    if (['opening', 'waiting_phone', 'awaiting_sas', 'checking'].includes(this.#view.step)) return this.#view;
    const gen = ++this.#gen;
    this.#reset();
    this.#set({ ...IDLE, step: 'opening' });
    const o = this.#o;
    const dev = o.device;
    try {
      const keys = await o.keys();
      const p = new DesktopPairing({
        keys,
        deviceList: dev.deviceList,
        relayHost: o.relayHost,
        now: this.#now,
        desktopName: o.desktopName,
        enrollPhone: (x) =>
          this.#step('enroll', () => o.account.enrollPhone(dev.auth, { deviceId: x.deviceId, role: 'mobile', platform: x.platform, name: x.name, Sx: b64(x.Sm), Vx: b64(x.Vm), roomId: b64url(x.roomId) })),
        publishDeviceList: (list) =>
          this.#step('devlist', async () => {
            await o.account.putDeviceList(dev.auth, list);
            await dev.setDeviceList(list);
          }),
        registerMailbox: (id, r, w, peer) =>
          this.#step('mailbox', async () => {
            await o.relayHttp.registerMailbox(dev.auth, id, r, w, peer);
            this.#mbx = { id, tokWrite: w };
          }),
        accountClaim: () => this.#step('acct_claim', () => dev.acctClaimField()),
      });
      this.#p = p;
      await o.relayHttp.createRoom(dev.auth, p.roomId);
      const offer = p.offer();
      const link = await o.relay.joinRoom(p.roomId, 'desktop');
      if (gen !== this.#gen) return (link.close(), this.#view);
      this.#link = link;
      const expiresAt = offer.exp * 1000;
      this.#set({ step: 'waiting_phone', qr: o.qr(offer.qr), expiresAt });
      this.#log('main.pair', { step: 'qr' });
      this.#timer = setTimeout(() => this.#expire(gen), Math.max(0, expiresAt - this.#now()));
      this.#timer.unref?.();
      void p.run(link).then(() => {
        if (gen !== this.#gen) return;
        if (p.state === 'awaiting_sas') this.#set({ step: 'awaiting_sas', qr: null, phoneName: p.phoneName, triesLeft: SAS_MAX_TRIES, error: null });
        else this.#fail('pair.handshake');
      });
    } catch (e) {
      if (gen === this.#gen) this.#fail(codeOf(e, 'pair.open_failed'));
      if (codeOf(e, '') === 'account.unauthorized') dev.clearToken();
    }
    return this.#view;
  }

  async submitSas(code: string): Promise<PairView> {
    const p = this.#p;
    if (!p || this.#view.step !== 'awaiting_sas') return this.#view;
    const gen = this.#gen;
    if (!/^\d{6}$/.test(code)) {
      this.#set({ error: 'pair.sas_shape' });
      return this.#view;
    }
    this.#set({ step: 'checking', error: null });
    this.#stepError = null;
    const r = await p.submitSas(code);
    if (gen !== this.#gen) return this.#view;
    if (r.ok) {
      this.#clearTimer();
      this.#mbx = null;
      this.#set({ step: 'paired', error: null, triesLeft: null });
      this.#log('main.pair', { step: 'paired' });
      this.#o.onPaired?.(r.result);
      const ch = r.result.channel;
      const t = setTimeout(() => ch.close(), this.#o.closeAfterMs ?? 5_000);
      t.unref?.();
      return this.#view;
    }
    if (p.state === 'failed') {
      this.#fail(this.#stepError ?? (r.triesLeft === 0 && !p.expired ? 'pair.sas_locked' : p.expired ? 'pair.expired' : 'pair.failed'));
      return this.#view;
    }
    this.#set({ step: 'awaiting_sas', triesLeft: r.triesLeft, error: 'pair.sas_wrong' });
    return this.#view;
  }

  dismiss(): PairView {
    if (this.#view.step !== 'paired') return this.cancel();
    this.#set(IDLE);
    return this.#view;
  }

  cancel(): PairView {
    const step = this.#view.step;
    this.#gen++;
    if (step !== 'paired' && step !== 'idle') this.#log('main.pair', { step: 'cancelled' });
    this.#p?.cancel();
    this.#cleanupMailbox();
    this.#reset();
    this.#set(IDLE);
    return this.#view;
  }

  async #step<T>(name: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      this.#stepError = codeOf(e, `pair.${name}_failed`);
      this.#log('main.pair', { step: name, result: this.#stepError });
      if (this.#stepError === 'account.unauthorized') this.#o.device.clearToken();
      throw e;
    }
  }

  #expire(gen: number) {
    if (gen !== this.#gen || !['waiting_phone', 'awaiting_sas'].includes(this.#view.step)) return;
    this.#p?.cancel();
    this.#fail('pair.expired');
  }

  #fail(code: string) {
    this.#clearTimer();
    this.#cleanupMailbox();
    this.#link?.close();
    this.#set({ step: 'failed', qr: null, error: code });
    this.#log('main.pair', { step: 'failed', result: code });
  }

  #cleanupMailbox() {
    const m = this.#mbx;
    this.#mbx = null;
    if (m) void this.#o.relayHttp.deleteMailbox(this.#o.device.auth, m.id, m.tokWrite).catch((e: unknown) => this.#log('main.pair', { step: 'mailbox_delete', result: codeOf(e, 'failed') }));
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #reset() {
    this.#clearTimer();
    this.#link?.close();
    this.#link = null;
    this.#p = null;
    this.#stepError = null;
  }
}
