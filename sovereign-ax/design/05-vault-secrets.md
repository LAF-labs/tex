# D05. 금고와 비밀 처리

> v1.2 — Review B(research/REVIEW-B-security.md) 반영: 금고가 Chrome 파이프의 단독 소유자, 엔진은 토큰 보호 중계 CDP, 비밀 입력 전용 창, 금고 전용 키 `Kv`와 인증 봉인, 보안카드 칸 단위 저장, 과장 문구 정정.

## 1. 목표와 정직한 범위

- 비밀(인증서 비밀번호, 포털 비밀번호, 보안카드 번호표, 기기 키, BYOK 키)이 평문으로 존재하는 장소를 **금고 프로세스 하나**로 제한한다.
- 비밀이 화면에 입력될 때도 엔진 프로세스를 거치지 않는다(비밀 타이피스트).
- **범위**: 이 설계는 평문이 엔진의 힙·로그·크래시 덤프·모델 페이로드에 남지 않게 하는 **위생 장치**다. 같은 OS 사용자의 악성코드나 엔진 RCE에 대한 **경계가 아니다**. 엔진이 침해되면 그 실행 중에 입력된 비밀은 DOM 되읽기로 노출될 수 있다. 이 문장은 D00·D01·D08·D11·README와 사용자 고지에 같은 표현으로 들어간다.
- 사용자가 저장을 원하지 않으면 저장하지 않고도 모든 작업이 돌아간다(매번 입력).

## 2. 비밀 목록과 정책

| 비밀 | 저장 기본값 | 저장소 | 사용 주체 | 로그 |
|---|---|---|---|---|
| 공동인증서 개인키 파일(`signPri.key`, PBKDF1+SEED-CBC 또는 PBES2) | 저장 안 함(원위치 참조) | 사용자 NPKI 폴더 | 포털 서명 모듈(브라우저). **하네스는 파일을 열지 않는다** | 경로만 |
| 인증서 비밀번호 | **미저장**(옵트인 저장). 홈택스 브라우저 인증서 모드는 가상키패드라 저장해도 자동 입력에 못 쓴다는 점을 저장 UI에 명시 | OS 키체인(사용자 범위) | 타이피스트(가상키패드 없는 칸만) | `secret.used` |
| 포털 아이디·비밀번호 | 미저장(옵트인) | 〃 | 타이피스트 | 〃 |
| 보안카드 번호표 | **미저장**(옵트인, 강한 경고) | **칸 단위 키체인 항목**(`securitycard/<profile>/<row>`), 각 항목 ≤ 2,560B. DB에는 두지 않는다(DB 키는 엔진이 가진다) | 타이피스트(해당 칸만) | 칸 번호만 |
| 간편인증 | 저장 없음 | 사용자 폰 | 사용자 | — |
| 기기 장기 키(`Sx`, `Vx`, `Qx`), 금고 키 `Kv` | 저장 | 키체인 | 금고 | — |
| `KEK_N`, `K_idx`, `K_meta`, `K_audit`(RK 파생) | 저장 | 키체인. **RK 자체는 상주시키지 않는다**(복구 문구에서 필요 시 재생성) | 금고 | — |
| DB 암호화 키 | 저장 | 키체인 → 엔진 시작 시 1회 전달 | 엔진 | — |
| BYOK API 키 | 저장(옵트인) | 키체인 → `net/egress` 모듈 메모리(엔진 프로세스 안). 평문이 엔진에 있다는 사실을 문서화 | egress | — |
| 계정 토큰 | 저장 | 키체인 → main/egress | | — |

## 3. 프로세스 구조: 금고가 Chrome을 소유한다 (ADR-005 v2)

- **금고 프로세스가 Chrome을 `--remote-debugging-pipe`로 띄우고 파이프의 단독 소유자**가 된다. `--remote-debugging-port`는 **사용 금지**(정책 상수·린트). 포트가 있으면 같은 PC의 다른 OS 계정·인포스틸러가 로그인된 포털 세션을 조종할 수 있다.
- 엔진은 금고가 중계하는 CDP를 쓴다. 전송은 Electron `MessagePort`(권장) 또는, 불가피하면 `/json` 디스커버리 없는 로컬 WS 프록시 + 256비트 경로 토큰. 프록시는 메시지 전달 + 소수의 차단 규칙만 가진다.
- 중계 차단 규칙(금고가 집행): 타이핑 구간 동안 엔진의 `Input.*`, `DOM.focus`, 탭 전환(`Target.activateTarget`), `Emulation.*` 명령을 **보류**하고 `Input.setIgnoreInputEvents(true)`로 사용자 입력도 잠깐 막는다. 구간이 끝나면 해제. 엔진이 `Runtime.evaluate`로 비밀 칸 값을 읽는 것은 막을 수 없다(§1의 정직한 범위).
- 기동 자기 점검: 금고가 `about:blank`에서 `navigator.webdriver === true`를 확인하고, 거짓이면 자동화를 거부한다(ADR-010을 연결 방식 변경이 깨지 않게 함).
- 전용 Chrome 프로필 정책: 비밀번호 저장·자동완성·동기화 **끔**(`PasswordManagerEnabled=false`, `AutofillAddressEnabled=false`, `SyncDisabled=true`), 종료 시 캐시 정리, `keep_session` 기본 **꺼짐**(사용자가 켤 수 있음).
- 엔진에는 포털 eTLD+1 **내장 허용 목록**(hometax.go.kr, gov.kr, 간편인증·서명 모듈 도메인)을, 금고에는 **비밀 종류별 origin 허용 목록**을 둔다. 둘 다 앱 업데이트로만 바뀐다(서명키 유출 시 피해 반경 제한, D11 T1).

```ts
interface VaultAPI {
  unlock(reason: string): Promise<void>;                        // 대화형 등급: Windows Hello/Touch ID 결박(Rust N-API)
  // 저장: 전용 입력 창(금고와 직결된 MessagePort)에서만 호출된다. main·renderer 본체는 평문을 중계하지 않는다
  store(kind: SecretKind, scope: ProfileId, row: number|null, consent: ConsentRecord): Promise<SecretHandle>;
  forget(handle: SecretHandle): Promise<void>;
  has(kind: SecretKind, scope: ProfileId): Promise<boolean>;
  browser: { launch(profileDir): Promise<void>; relayPort(): MessagePort; shutdown(): Promise<void>; };
  typist: {
    fill(req: {targetId: string; frame: FrameId; element: ElementLocator; secret: {kind: SecretKind; scope: ProfileId; row?: number}}): Promise<{ok: boolean; reason?: 'denied'|'not_found'|'blocked_by_module'|'origin_not_allowed'|'not_secret_slot'}>;
    fillFromRemote(req: {sealed: Uint8Array; reqId: string}): Promise<{ok: boolean}>;   // 폰에서 온 인증 봉인문
    newVaultChallenge(reqId: string): Uint8Array;                                         // human.request에 실어 보냄
  };
  crypto: { kvPublic(): PublicKey; noiseStatic(): PublicKey; wrapDEK(dek, blobId, kekVer): Wrapped; unwrapDEK(w, blobId): DEK; };
  getDbKeyOnce(): Promise<Uint8Array>;
}
```

규칙: 어떤 메서드도 평문 비밀을 반환하지 않는다(`getDbKeyOnce` 예외는 앱 내부 키). 타이피스트는 `engine` 포트에서만, `store`는 전용 입력 창 포트에서만 호출 가능. 엔진은 CDP 엔드포인트를 **지정할 수 없다**(인자 자체가 없다).

## 4. 비밀 타이피스트

1. 엔진이 `secret_fill`에 도달하면 `targetId`·프레임·요소 로케이터·비밀 종류를 금고에 넘긴다.
2. 금고는 자기 파이프 세션으로 요소를 찾아 다음을 **모두** 확인한다: 현재 프레임 origin이 비밀 종류의 허용 목록 안, 요소가 `type=password` 또는 셀렉터 사전 `secretSlot`, 요소가 `activeElement`, 보안카드면 `row`가 화면에서 읽은 값과 일치. 하나라도 어긋나면 입력하지 않는다.
3. 엔진 명령 보류 + `setIgnoreInputEvents(true)` → `Input.dispatchKeyEvent`로 글자 단위 입력(간격은 정책 상수 고정값 150ms, '사람 수준'이라는 표현은 쓰지 않는다) → 키 입력마다 `activeElement`·`type` 재확인 → 완료 후 해제.
4. 비밀 버퍼는 즉시 0으로 덮는다(`sodium_memzero`). JS 문자열은 영화할 수 없으므로 글자 단위 변환을 Rust N-API 헬퍼로 옮기는 것을 Phase 2 과제로 둔다.
5. 엔진은 `{ok, reason}`만 받는다.

제약:
- 홈택스 브라우저 인증서 모드는 **가상키패드 필수**다. 키로거 방지 장치이므로 타이피스트가 대신 누르지 않는다 → `human:secret`(사용자 직접). 커널 드라이버 기반 키보드 보안(nxKey 계열) 칸도 합성 입력이 닿지 않을 가능성이 높다(S1b 확인). 따라서 홈택스 공동인증서 경로는 **매번 사용자가 비밀번호를 입력**하고, 간편인증 PUSH는 폰 승인이다. 타이피스트의 실제 가치는 포털 비밀번호·보안카드 등 모듈 없는 칸에 있다.
- 보안카드는 칸마다 별도 `secret_fill`로 나눈다(한 스텝에서 여러 칸 금지).

## 5. 폰에서 온 비밀 (라이브 세션 전용)

- 금고 전용 키 `Kv`(X25519, 금고가 생성, 기기 밖으로 안 나감). `Vd`로 서명해 `PAIR_OK`·`HELLO`로 폰에 배포하고 연 1회 회전.
- 봉인: 폰 전용 키로 **인증 모드**(HPKE Auth 또는 `crypto_box`)로 봉인하고, AAD = `{pair_id, runId, stepId, reqId, vaultChallenge, exp, origin, secretKind}`. `vaultChallenge`는 **금고가** 만들어 `human.request`에 실어 보내고 1회 사용 후 폐기한다. `crypto_box_seal`(익명 봉인)은 쓰지 않는다.
- 금고는 챌린지·exp·origin·secretKind가 현재 프레임·허용 목록과 맞을 때만 입력한다. 침해된 엔진이 과거 봉인문을 재생해도 챌린지가 맞지 않아 거부된다.
- 큐 금지: 비밀·캡차 답은 오프라인 의도 봉투에 넣지 않는다(D08 §7).
- 폰 쪽: 비밀 입력란은 스크린샷 차단, 클립보드 금지, 자동완성 금지, 저장 옵션 없음.

## 6. 공동인증서(NPKI) 입장

- 하네스는 개인키 파일을 **열지 않는다**. 서명은 포털 모듈이 한다. 하네스는 인증서 선택 + 비밀번호 입력(타이피스트가 가능한 칸) 또는 핸드오프까지만. 로컬 서명은 Phase 3 이후 Rust 옵션으로만 검토.
- S1b(브라우저 인증서 가져오기)는 인증서 **파일을 업로드 칸에 넣는 동작**이다. 이는 "파일을 연다"가 아니라 사용자의 파일을 포털에 전달하는 것이며, 비밀번호는 여전히 사용자가 입력한다. 문서에 이 구분을 적는다.

## 7. OS 저장소

| OS | 저장 | 보호 | 한계 |
|---|---|---|---|
| Windows | Credential Manager(`@napi-rs/keyring` v2.1.x), 항목당 ≤ 2,560B | 사용자 로그온 자격 증명에 바인딩. 대화형 등급은 Windows Hello 키 결박(Rust N-API, 서명-챌린지 → KEK) | 같은 사용자의 다른 프로세스가 읽을 수 있음 |
| macOS | Keychain(`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, 동기화 금지) | 코드서명 기반 ACL(Electron fuses 전제), Touch ID 결박 옵션 | 동일 |

`keytar`는 아카이브됨, Electron `safeStorage`는 메인 프로세스 전용이라 부적합. 대화형 등급(결박)과 무인 등급(결박 없음, 저장 범위 최소)을 나눈다(S10).

## 8. 메모리·로그·덤프 위생

- 비밀은 `Uint8Array`/네이티브 버퍼로만. 문자열·JSON 직렬화 금지(린트 `no-secret-stringify`).
- 금고는 크래시 덤프 생성을 비활성화한다. **엔진·메인의 덤프는 업로드하지 않는다**(DB 키·토큰·PII 포함 가능).
- 로그 포맷터는 `SecretBytes`를 `[secret]`로 치환.
- 누출 스캐너(D13 §6)는 글자 단위 CDP 메시지·IPC 캡처·클립보드·전용 프로필 디스크까지 본다. S6에 "다른 OS 사용자 계정에서 CDP 접속 불가", "엔진이 지정한 엔드포인트로 금고가 접속하지 않음(인자 없음)"을 넣는다.

## 9. 동의와 투명성

- 저장 시점 UI: 무엇을, 어디에, 왜 저장하는지 + "저장하지 않아도 됩니다" 선택지 동등 노출 + §1의 범위 문구("같은 PC의 악성코드로부터 보호하지 못합니다").
- 설정 "저장된 비밀" 목록 + 개별 삭제. 감사 로그 `secret.used`로 "언제 쓰였는지" 열람.
