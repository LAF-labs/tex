// 집에 둔 PC를 밖의 폰이 바로 쓰게 하는 앱 쪽 규칙(폰 연결이 하나라도 있을 때만).
//  - 창을 닫아도 앱이 끝나지 않는다: Windows·Linux는 작업 표시줄로 내리고(다시 누르면 열린다), macOS는 숨긴다(Dock에 남는다).
//    완전히 끝내기는 메뉴 [창 > 소버린 AX 끝내기](Ctrl/Cmd+Q).
//  - 전원에 꽂혀 있으면 유휴 잠자기를 막는다(powerSaveBlocker 'prevent-app-suspension', 화면은 꺼지고 잠긴다). 배터리면 막지 않는다.
//  - 사용자가 직접 재우면 막지 않는다. 깨어나면 PhoneLink.wake('resume')로 바로 다시 붙는다.
// 화면 잠금은 그대로다: 폰이 보내는 것은 영수증·현금매출 받기뿐이고 발급·제출은 PC 앞 사람의 승인이 있어야 한다(ADR-026).

type CloseAction = 'quit' | 'minimize' | 'hide';

/** 창 닫기 단추를 눌렀을 때 할 일. */
export function closeAction(o: { phones: number; quitting: boolean; platform: NodeJS.Platform }): CloseAction {
  if (o.quitting || o.phones === 0) return 'quit';
  return o.platform === 'darwin' ? 'hide' : 'minimize';
}

/** 잠자기를 막을지. */
export function shouldStayAwake(o: { phones: number; onBattery: boolean }): boolean {
  return o.phones > 0 && !o.onBattery;
}

interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

/** powerSaveBlocker를 켠 상태와 원하는 상태를 맞춘다. 같은 값이면 아무것도 하지 않는다. */
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

/**
 * 계정 화면이 바뀔 때(로그인·로그아웃·새 PC 연결 끝) 폰 수신을 켤지.
 * 기기 신원이 있는데 수신이 꺼져 있으면 켠다. 전에는 앱을 켤 때만 켜서, 같은 실행에서 로그아웃 → 다시 로그인하면
 * 앱을 다시 켤 때까지 폰이 "PC 꺼짐"으로 보였다(로그아웃은 수신을 멈추고 버린다).
 */
export function shouldStartPhones(o: { signedIn: boolean; running: boolean }): boolean {
  return o.signedIn && !o.running;
}
