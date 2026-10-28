# D05. 금고와 비밀 처리

## 1. 목표

- 비밀(인증서 비밀번호, 포털 비밀번호, 보안카드 번호표, 기기 키, BYOK 키)이 평문으로 존재하는 장소를 **금고 프로세스 하나**로 제한한다.
- 비밀이 화면 입력에 쓰일 때도 엔진 프로세스를 거치지 않는다(비밀 타이피스트).
- 사용자가 저장을 원하지 않으면 저장하지 않고도 모든 작업이 돌아간다(매번 입력).

## 2. 비밀 목록과 정책

| 비밀 | 저장 기본값 | 저장소 | 사용 주체 | 로그 |
|---|---|---|---|---|
| 공동인증서 개인키 파일(`signPri.key`, PBKDF1+SEED-CBC 또는 PBES2) | 저장 안 함(원위치 참조) | 사용자 NPKI 폴더 | 포털 서명 모듈(브라우저). **하네스는 파일을 열지 않는다** | 경로만 |
| 인증서 비밀번호 | **미저장** (옵트인 저장) | OS 키체인(DPAPI 사용자 범위 / Keychain) | 타이피스트 | `secret.used` 이벤트만 |
| 포털 아이디·비밀번호 | 미저장(옵트인) | 〃 | 타이피스트 | 〃 |
| 보안카드 번호표 | **미저장** (옵트인, 강한 경고) | 〃 (칸 단위 암호화) | 타이피스트(해당 칸만) | 칸 번호만 |
| 간편인증 | 저장 없음 | 사용자 폰 | 사용자 | — |
| 기기 장기 키(Noise static) | 저장 | 키체인 | 금고(핸드셰이크) | — |
| 백업 KEK | 저장 | 키체인 + 복구 문구(사용자 보관) | 금고 | — |
| DB 암호화 키 | 저장 | 키체인 | 금고가 엔진에 세션 시작 시 1회 전달 | — |
| BYOK API 키 | 저장(옵트인) | 키체인 | 금고 → `net/egress`에 헤더 주입(엔진 미경유) | — |

## 3. 프로세스와 IPC 계약

금고는 Electron `utilityProcess`로 뜨고, `main`과 `engine`과만 MessagePort로 통신한다. 아웃바운드 네트워크 금지(코드 수준 + 프로세스 샌드박스).

```ts
interface VaultAPI {
  unlock(reason: string): Promise<void>;                       // OS 인증(Windows Hello/Touch ID) 옵션 게이트
  store(kind: SecretKind, scope: ProfileId, value: SecretBytes, consent: ConsentRecord): Promise<SecretHandle>;
  forget(handle: SecretHandle): Promise<void>;
  has(kind: SecretKind, scope: ProfileId): Promise<boolean>;
  // 비밀 타이피스트: 값은 반환하지 않는다
  typist: {
    fill(req: {cdpEndpoint: string; targetId: string; frameSelector: FrameLocator; element: ElementLocator;
               secret: {kind: SecretKind; scope: ProfileId; row?: number}; pace: PacePolicy}): Promise<{ok: boolean; reason?: 'denied'|'not_found'|'blocked_by_module'}>;
    fillFromRemote(req: {sessionId: string; stepId: string; element: ElementLocator}): Promise<{ok: boolean}>; // 폰에서 온 암호문을 금고가 복호화해 입력
  };
  // 기기 키 연산(핸드셰이크·블롭 봉투)
  crypto: { noiseStatic(): PublicKey; noiseHandshake(...): ...; wrapDEK(dek): Wrapped; unwrapDEK(w): DEK; };
  getDbKeyOnce(): Promise<Uint8Array>;                          // 세션당 1회, 엔진 시작 시
}
```

규칙:
- `store()`는 `ConsentRecord{at, uiVersion, text}`를 함께 저장한다. 설정 화면에서 언제든 `forget()`.
- 어떤 메서드도 평문 비밀을 반환하지 않는다. 예외는 `getDbKeyOnce()`(DB 키는 사용자 비밀이 아니라 앱 내부 키).
- 금고는 요청자가 `engine`인지 `main`인지 포트로 구분하고, 타이피스트는 `engine`만, `store`는 `main`(UI 경유)만 호출할 수 있다.

## 4. 비밀 타이피스트 (ADR-005)

동작:
1. 엔진이 `secret_fill` 스텝에 도달하면 현재 Chrome의 CDP 엔드포인트, 대상 `targetId`(탭), 요소 로케이터를 금고에 넘긴다.
2. 금고가 **자기 CDP 세션**을 연다(Chrome은 다중 CDP 클라이언트를 허용). 요소를 찾아 포커스하고, 키체인에서 비밀을 꺼내 사람 속도로 키 입력을 보낸 뒤 CDP 세션을 닫는다.
3. 입력은 CDP `Input.dispatchKeyEvent`를 글자 단위로 보낸다(Playwright `fill()`은 JS 문자열을 요구하므로 쓰지 않는다). 메모리의 비밀 버퍼는 즉시 0으로 덮는다(`sodium_memzero`). JS 문자열은 영화할 수 없으므로 글자 단위 변환도 Rust N-API 헬퍼로 옮기는 것을 Phase 2 과제로 둔다.
4. 엔진은 `{ok}`만 받는다. 입력된 값, 길이, 타이밍을 받지 않는다.

제약과 폴백:
- 커널 드라이버 기반 키보드 보안 모듈(nxKey 계열)이 걸린 칸은 CDP 합성 키 입력이 닿지 않을 가능성이 높다(R3 추정, S1b에서 확인). 이 경우 `blocked_by_module` → 플레이북의 `onFail: human:secret` → 사용자가 직접 입력(데스크톱 전면). 폰 경유 비밀 입력도 결국 타이피스트를 쓰므로 같은 제약을 받는다. 홈택스 '브라우저 인증서' 모드가 모듈 없이 동작하면 그 경로를 기본으로 한다.
- 홈택스 '브라우저 인증서' 모드는 공식 문서상 **가상키패드 필수**다. 가상키패드는 키로거를 막기 위한 장치이므로 타이피스트가 키패드 버튼을 대신 눌러 주는 것은 하지 않는다. 그 칸은 사용자 직접 입력(`human:secret`)이고, 타이피스트는 가상키패드가 없는 칸(포털 비밀번호·보안카드 등)에서만 동작한다. 이로써 홈택스 공동인증서 경로의 무인 실행은 사실상 불가하며, 무인 데몬은 간편인증이 아닌 한 반자동이다.
- 타이피스트는 **비밀 종류가 허용된 요소**에만 입력한다: 요소의 `type=password` 또는 셀렉터 사전에 `secretSlot: true` 표시가 있어야 한다. 일반 텍스트 칸에 비밀을 넣는 요청은 거부한다(플레이북 버그·악성 패키지 방어).
- 보안카드: 포털이 요구한 칸 번호를 엔진이 화면에서 읽어(비밀 아님) 금고에 `row`로 전달. 금고는 그 칸의 값만 입력.

## 5. 폰에서 온 비밀 (리모트 세션)

- 폰 앱이 사용자가 입력한 비밀을 **데스크톱 금고의 공개키로** 봉인한다(세션 키가 아니라 금고 키로 이중 봉인). 엔진은 세션 메시지를 받아도 복호화할 수 없다.
- 금고가 복호화 → 타이피스트 입력 → 폐기. 폰 쪽도 입력 후 즉시 폐기, 저장 옵션 없음.

## 6. 공동인증서(NPKI) 입장

- 하네스는 개인키 파일을 **열지 않는다**. 서명은 포털의 브라우저 서명 모듈이 수행한다. 하네스는 (1) 인증서 선택 화면에서 올바른 인증서를 고르고 (2) 비밀번호 칸에 타이피스트로 입력하는 것까지만 한다.
- 이유: 개인키 복호화·서명을 자체 구현하면 전자서명법·인증기관 약관상 책임 범위가 넓어지고, 포털별 서명 포맷 추적 부담이 생긴다. 반면 모듈을 그대로 쓰면 "사용자가 손으로 하는 것"과 동일한 경로다.
- 예외 검토: 스파이크 S1에서 모듈이 CDP 입력을 전면 거부하면, 공동인증서 경로는 "사용자가 비밀번호를 직접 입력"으로 고정하고 간편인증 경로를 기본으로 권장한다.

## 7. OS 저장소 세부

| OS | 저장 | 보호 | 한계 |
|---|---|---|---|
| Windows | Credential Manager(Generic Credential) 또는 DPAPI 암호문 파일 | 사용자 로그온 자격 증명에 바인딩. 선택적으로 Windows Hello 확인 후 사용 | 같은 사용자 계정의 다른 프로세스가 읽을 수 있음 → 금고 프로세스 외 접근은 OS가 막지 않는다. 앱 수준 추가 키 래핑(DB 키로 2차 암호화) |
| macOS | Keychain(앱 접근 그룹, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) | 코드서명 기반 접근 제어, Touch ID 옵션 | 동기화 금지 플래그 필수 |

라이브러리: **`@napi-rs/keyring`**(v2.1.x). `keytar`는 아카이브됨, Electron `safeStorage`는 메인 프로세스 전용이라 금고 프로세스에 부적합. Windows Credential Manager는 항목당 2,560바이트 상한이므로 큰 값(보안카드 전체 표)은 DB 키로 암호화해 DB에 두고 키체인에는 키만 둔다. DPAPI·Credential Manager·Keychain 모두 **같은 사용자의 다른 프로세스가 읽을 수 있다**. 프로세스 분리는 우리 코드 내부의 노출 범위를 줄이는 장치이지 같은 사용자 악성코드에 대한 경계가 아니며, 이 사실을 문서와 설정 화면에 그대로 적는다. Windows Hello/Touch ID 결박은 UI 게이트가 아니라 키 자료 결박(Rust N-API 헬퍼, Bitwarden의 서명-챌린지 패턴)으로 구현하고, 무인 데몬과는 양립하지 않으므로 '대화형 등급'(결박)과 '무인 등급'(결박 없음, 저장 범위 최소) 두 등급으로 나눈다(S10).

## 8. 메모리·로그 위생

- 비밀은 `Uint8Array`/네이티브 버퍼로만 다룬다. 문자열·JSON 직렬화 금지(린트 규칙 `no-secret-stringify`).
- 금고 프로세스는 크래시 덤프 생성을 비활성화한다. 엔진·메인은 덤프를 만들되 비밀이 없으므로 안전.
- 로그 라이브러리는 `SecretBytes` 타입을 직렬화할 때 `[secret]`로 치환하는 포맷터를 강제한다.
- 테스트: `13-testing.md` §6 비밀 누출 스캐너(로그·덤프·텔레메트리 페이로드에서 테스트 비밀 패턴 검색).

## 9. 동의와 투명성

- 저장 시점 UI: 무엇을, 어디에, 왜 저장하는지 + "저장하지 않아도 됩니다" 선택지 동등 노출.
- 설정 화면 "저장된 비밀" 목록(종류·프로필·저장일) + 개별 삭제.
- 감사 로그에 `secret.used`(종류·시각)만 기록되어 사용자가 "언제 내 비밀번호가 쓰였는지" 볼 수 있다.
