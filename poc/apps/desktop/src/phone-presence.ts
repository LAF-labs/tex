
type CloseAction = 'quit' | 'minimize' | 'hide';

export function closeAction(o: { phones: number; quitting: boolean; platform: NodeJS.Platform }): CloseAction {
  if (o.quitting || o.phones === 0) return 'quit';
  return o.platform === 'darwin' ? 'hide' : 'minimize';
}

export function shouldStayAwake(o: { phones: number; onBattery: boolean }): boolean {
  return o.phones > 0 && !o.onBattery;
}

interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export class StayAwake {
  #id: number | null = null;
  #b: PowerBlocker;
  #log: (on: boolean) => void;
  constructor(b: PowerBlocker, log: (on: boolean) => void = () => {}) {
    this.#b = b;
    this.#log = log;
  }
  get on(): boolean {
    return this.#id !== null;
  }
  set(want: boolean): void {
    if (want === this.on) return;
    if (want) this.#id = this.#b.start('prevent-app-suspension');
    else {
      this.#b.stop(this.#id!);
      this.#id = null;
    }
    this.#log(want);
  }
}

export function shouldStartPhones(o: { signedIn: boolean; running: boolean }): boolean {
  return o.signedIn && !o.running;
}
