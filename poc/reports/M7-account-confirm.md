# M7 저장 전 계정 확인 화면(설계 #120)과 실기기 개발 준비 (2026-11-06)

## 확인 화면

`PAIR_OK` 검사(AIK 서명 목록·Sd·Cert_M·Kv)를 통과한 뒤, 키를 저장하기 전에 띄운다. 순서는 다음과 같다.

1. SAS 일치
2. `PAIR_OK` 검사
3. 24시간 경고(해당할 때만)
4. **PC 이름·가린 계정 이메일 확인**
5. 저장

[내 계정 맞음]을 눌러야 저장한다. [아니에요, 중단]을 누르면 아무것도 저장하지 않는다.

- **필드 이름은 가정이다.** `PAIR_OK.desktopName`·`PAIR_OK.accountEmail`이고, `readPairIdentity`가 읽는다(packages/remote).
  - 이메일이 서명된 채로 오는지는 설계 세션이 확인 중이다. 스키마와 PC는 아직 보내지 않는다.
  - 그래서 지금 화면에는 "이름을 받지 못했어요"·"계정 정보를 받지 못했어요"가 보인다.
  - 모양이 틀린 값과 제어·양방향 문자가 든 값은 버린다.
- 폰에는 **가린 이메일만** 저장한다(`ow•••@example.test`). 연결 화면(P-06)에 "연결한 PC"·"계정" 줄로 늘 보인다.

| 확인 화면 | 연결 화면 | 앱 스위처(영수증 확인 화면에서) |
|---|---|---|
| ![](raw/m7-account-confirm/01-confirm.png) | ![](raw/m7-account-confirm/02-connection.png) | ![](raw/m7-account-confirm/03-app-switcher.png) |

앱 스위처 스냅샷: 영수증 확인 화면에서 앱 스위처를 열었다. 카드에는 가림막만 보이고 영수증은 남지 않았다(시뮬레이터). 실기기에서 다시 본다.

## 실기기 개발 준비

- 개발 스택을 맥의 mDNS 이름으로 연다: `STACK_HOST=<소문자 LocalHostName>.local:8787`.
  - 앱은 `EXPO_PUBLIC_TEX_DEV_HOST`로 같은 값을 받는다. 이 값은 실기기 개발 빌드에서만 쓰고, 시뮬레이터 완화(생체 없는 키·견본 카메라)는 켜지 않는다.
  - 평문 http/ws·DPoP `htu`는 `localhost`와 `<이름>.local`만 허용한다. IP와 공개 도메인은 계속 거부한다.
- 더미 PC가 `/dev/qr.html`로 QR을 보여 준다. 실기기 카메라로 찍는다.
- 서명:
  - 팀 ID는 `APPLE_TEAM_ID`로 넘긴다(저장소에 두지 않음).
  - `pod install`에는 UTF-8 로캘이 필요하다.
  - **막힘:** Apple Program License Agreement 갱신 동의가 필요하다(사용자 계정). 동의 전에는 프로비저닝 프로필을 만들 수 없다.
