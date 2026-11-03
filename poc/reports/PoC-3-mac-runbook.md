# PoC-3 맥 사전 관찰 절차서 (yanggang 실행용, 2026-11-03)

보드 태스크 `PoC-3-mac`을 맡은 Claude가 이 문서대로 진행한다. yanggang은 개발 지식 없이 승인과 홈택스 조작만 하면 된다.

**용어 풀이**

- **브랜치**: 내 수정본을 따로 담는 갈래
- **커밋**: 수정본 저장
- **PR**: 바뀐 파일을 검토해 달라는 요청
- **Bugbot**: PR을 자동으로 검토하는 도구
- **셀렉터**: 화면 요소를 찾는 이름표
- **iframe**: 페이지 안의 작은 페이지
- **보드**: LAF Board의 작업 목록

**Claude용 근거**: D13 S1·S1b, D18 §1·§3·§4, ADR-017 결정 5, ADR-020, D05 §6, `PoC-1.md` §3·§4·§7, `PoC-6.md` §6, `PoC-10.md`, ADR-025(PoC-3 안전 기준선), `PoC-1-risk-acceptance.md` §3, `packages/engine/src/h01/portal.ts`(셀렉터 형식).

## 1. 목적과 범위

Windows 실측(PoC-3) 전에, 사람이 맥에서 홈택스를 직접 조작하며 다음을 모은다.

- **로그인(S1b)**: 공동인증서를 브라우저에 저장해 로그인하는 흐름, 가상키패드·키보드보안·보안 프로그램 설치 요구 여부.
- **셀렉터 재료**: 로그인 뒤부터 '전자(세금)계산서 건별발급' 화면까지 각 화면 요소의 역할·이름·id·name·aria-label. `HOMETAX_PORTAL`의 `TODO(PoC-3)`를 채운다.
- **발급 폼 구조**: 이메일 칸·공급자 칸의 위치, 발급 버튼 이름, 폼 요소와 버튼 종류. 암묵 제출(Enter 등) 여부를 판단할 단서다.
- **멈춤 신호**: 경고·대기열·추가 인증 화면의 문구. 요청률 정책 사전을 채울 재료다.

**범위 밖**: 실발급, 발급 버튼 뒤의 서명 흐름과 요청, 반영 지연, 자동 실행, 우리 앱으로 홈택스 열기(Windows에서 한다), 다른 포털(정부24·위택스 등).

## 2. 역할

| 누가 | 하는 일 |
|---|---|
| yanggang | 홈택스의 모든 클릭·입력, 인증서 고르기, 비밀번호 입력(가상키패드), 승인 |
| Claude | 단계 안내, 터미널·git·GitHub 명령 실행(yanggang은 승인 창만 누른다), 화면 구조 **읽기만**, 가린 기록, 보고서·PR·보드 글 |
| yulmu | 시작 허락, 보안 프로그램 설치 판단, 멈춘 뒤 재개 판단, PR 머지 |

## 3. 절대 하지 않는 것

Claude와 yanggang 모두에게 해당한다. 어기게 될 것 같으면 그 자리에서 멈추고 묻는다.

1. **발급 화면에서는 입력하지 않는다.** 6절 9번의 거래처 '선택' 말고는 어떤 칸에도 입력하지 않고 체크하지 않는다. 발급하기·전송·저장·임시저장·등록·신청·서명·삭제 버튼을 누르지 않는다. 등록번호 '확인' 조회도 누르지 않는다. Enter 키는 누르지 않는다.
2. **창이 뜨면 누르기 전에 문구부터 확인한다.** yanggang이 문구를 값 없이 Claude에게 읽어 준다.
   - 발급·저장·전송·등록·삭제를 묻지 않는 안내 창일 때만 '확인'을 누른다.
   - 그 밖에는 '취소' 또는 '아니오'를 누른다.
3. **비밀은 채팅에 오지 않는다.** 인증서 비밀번호와 보안카드 번호는 Claude가 묻지 않고 yanggang도 쓰지 않는다.
4. **Claude는 홈택스를 조작하지 않는다.** 홈택스 탭에서 Claude가 쓰는 것은 아래뿐이다.
   - 쓸 수 있는 것:
     - `tabs_create_mcp`: 첫 탭을 열고 홈택스 첫 주소를 넣을 때 한 번만 쓴다.
     - `tabs_context_mcp`
     - `read_page`
     - `find`
     - 8절의 구조 확인 스크립트(`javascript_tool`)
   - 쓰지 않는 것: `navigate`, `computer`(클릭·입력·스크린숏), `form_input`, `get_page_text`, `read_network_requests`, `read_console_messages`, `gif_creator`, 그 밖의 스크립트.
   - 보지 않는 것: 입력값, 쿠키, 저장소(localStorage·IndexedDB), 스크립트 소스, 이벤트 리스너.
5. **이런 창이 떠 있으면 Claude는 아무것도 읽지 않는다.** 인증서 선택 창, 비밀번호·가상키패드 창, 파일 선택창, 거래처 조회 창이 해당한다. 그동안의 기록은 yanggang이 말해 준 버튼 이름과 '있다/없다'로만 남긴다.
6. **식별 정보를 남기지 않는다.**
   - 남기지 않는 것: 사업자번호, 주민번호, 이름, 상호, 주소, 이메일, 전화, 금액, 거래처, 승인번호, 인증서 소유자, 인증서 파일 경로·이름.
   - 화면 라벨(예: "공급받는자 등록번호")만 쓰고, 값은 `[값]`으로 바꾼다.
   - 화면 캡처는 찍지 않는다.
   - `read_page` 결과를 그대로 파일·보드·PR에 옮기지 않는다.
7. **보안 프로그램을 분석하거나 우회하지 않는다.** 이름과 설치 화면의 버전만 적는다. 자동화 흔적을 감추는 설정도 하지 않는다.
8. **같은 계정을 겹쳐 쓰지 않는다.** 진행 중에는 같은 계정으로 폰(손택스)이나 다른 PC에서 로그인하지 않는다. 로그인은 하루 2회까지다(앱이 세지 못하는 사람 규칙이다. 같은 날 Windows PoC-3을 하지 않는다). 사무실·집 회선만 쓰고 VPN·프록시는 쓰지 않는다.
9. **홈택스만 연다.**

## 4. 멈출 조건과 멈춘 뒤

**멈출 조건** — 하나라도 나오면 그 자리에서 진행을 멈춘다.

- 경고·차단 안내, '비정상 접근'류 문구, 캡차, 로그인을 마친 뒤 추가 인증이 연달아 뜸(로그인 중의 2차 인증 1회는 정상, ADR-025 결정 4), 대기열 화면이 오래 이어짐, 다른 곳 로그인으로 끊김
- 로그인 말고 인증서·서명 창이 뜸(바로 '취소')
- 인증서 등록·변경·회원가입·약관 동의 창
- 발급 완료·승인번호 화면
- 비밀번호 오류 1회
- 임시저장 자료를 불러오거나 지우겠냐는 창

**멈춘 뒤 할 일**

1. 문구를 가려서 기록한다.
2. 로그아웃한다.
3. 보드 태스크를 `blocked`로 바꾼다.
4. 보드 공지로 **같은 계정의 홈택스 작업 전부(Windows PoC-3 포함)를 24시간 멈춘다**고 알린다(D18 §3). 재개는 yulmu가 정한다. 다시 시도하지 않는다.

**실수로 발급됐을 때**: 취소·수정을 시도하지 않는다. 화면을 그대로 두고 yulmu와 대표에게 바로 알린다. 보드에는 `blocker`로 남긴다.

## 5. 준비

1. **보드.**
   - 태스크를 `board_claim`으로 가져온다.
   - **yulmu가 태스크 스레드에 '시작 가능'을 남기기 전에는 로그인하지 않는다.** PoC 계정 지정과 위험 수용 서명 상태는 yulmu가 판단한다(`PoC-1-risk-acceptance.md`).
   - 보드에 24시간 안의 차단 신호 공지가 있으면 시작하지 않는다.
2. **인증서.**
   - yanggang에게 묻는다: "yulmu가 정한 관계사 법인 인증서인가요? 그 인증서 파일이 이 맥에 있나요? 종류는 선택창의 '용도' 칸만 말해 주세요."
   - 개인 인증서면 진행하지 않는다.
   - 기록에는 'PoC 계정 맞음'과 용도(사업자범용/전자세금계산서용)만 남긴다.
3. **시간.** 같은 계정의 다른 홈택스 사용(대표·직원·세무대리인·Windows PoC-3)과 겹치지 않는지 yulmu에게 확인한다. Windows PoC-3과는 **같은 날** 겹치지 않아야 한다. 맥 로그인은 앱이 세지 못해, 같은 날 Windows까지 하면 하루 로그인 상한(3회, ADR-025 결정 1)을 넘을 수 있다(위험 수용 기록 §3). 태스크 스레드로 묻는다.
4. **저장소와 GitHub.** 명령은 모두 Claude가 실행한다. yanggang은 승인 창과 브라우저 로그인만 한다.
   - 저장소가 없으면 Claude가 `~/Documents/tex`에 `LAF-labs/tex`를 clone한다(비공개 저장소).
   - Claude가 `gh auth status`로 로그인을 확인한다.
     - 없으면 Claude가 설치하고 `gh auth login`을 실행한다.
     - yanggang은 열린 브라우저에서 코드를 넣어 승인한다.
     - yanggang 계정에 저장소 권한이 없으면 yulmu에게 요청한다.
   - Claude가 `main`에서 브랜치 `poc/poc-3-mac-observe`를 만든다.
5. **Chrome.**
   - yanggang이 테스트 전용 **새 Chrome 프로필**을 만든다. Google 동기화는 켜지 않고, 비밀번호·주소 저장 제안은 거절한다.
   - 그 프로필에 Claude in Chrome 확장을 설치한다.
   - Claude가 `list_connected_browsers`로 새 프로필만 연결됐는지 보고 `select_browser`로 고른다.
   - 사이트 허용 창은 yanggang이 승인한다.
   - 확장을 쓸 수 없으면, 셀렉터 재료는 빼고 6절 A와 메뉴 경로만 yanggang의 말로 기록한다. 이때는 보고서와 보드 요약에 '셀렉터 재료 없음(확장 연결 불가)'이라고 적는다. 그래도 이 태스크는 완료로 본다.
6. **시작 승인.** 3~6절을 yanggang에게 짧게 설명하고 승인을 받는다.

## 6. 절차

### A. 로그인(S1b)

1. Claude가 새 프로필에서 `tabs_create_mcp`로 `https://hometax.go.kr`을 연다. 그 뒤 조작은 yanggang이 한다.
2. yanggang이 로그인 → '공동·금융인증서'로 간다.
   - 인증서 위치는 '브라우저'를 먼저 시도한다.
   - 파일 선택창이 뜨면 yanggang이 인증서 파일을 직접 고른다.
3. yanggang이 비밀번호를 가상키패드로 넣고 "입력 끝"이라고 말한다. 이 단계(2~3번) 동안 Claude는 읽지 않는다.
4. 로그인 뒤 Claude가 기록하는 것:
   - 각 단계에서 yanggang이 말해 준 버튼 이름
   - 보안 프로그램 설치 요구(이름만)
   - 가상키패드·키보드보안 여부
   - '인증서 등록'이 따로 필요했는지
   - 대략의 소요 시간과 막힌 곳
   - 로그인 상태를 알 수 있는 요소(역할·이름)
5. **보안 프로그램 설치를 요구하면 설치하지 않고 멈춘다.**
   - 이름을 기록하고, yulmu에게 판단을 받는다.
   - 설치하게 되면 내려받기와 맥 관리자 비밀번호 입력은 yanggang이 한다. Claude는 설치 파일을 받거나 실행하지 않는다.
   - 시스템 확장·입력 모니터링 권한을 요구하는 경우도 같다.

### B. 건별발급 화면까지(발급 없음)

6. yanggang이 메뉴로 '전자(세금)계산서 건별발급' 화면까지 간다.
   - Claude는 메뉴 이름 순서와 주소를 기록한다.
   - 주소는 경로와 `?` 뒤의 화면 ID 값(`w2xPath`·`menuCd` 등)만 남기고, 나머지 쿼리와 `#` 뒤는 버린다.
7. 화면마다 Claude가 `read_page`(필요하면 `find`)와 8절 스크립트로 요소를 읽어 7절 형식으로 남긴다. 기록하는 것은 역할, 이름(라벨), id·name·aria-label, 프레임, 필수 표시다.
   - 안 읽히는 부분은 `find`로 한 번 더 본다.
   - 그래도 안 되면 `note`에 '읽기 불가'라고 적고 넘어간다.
8. 건별발급 화면에서 추가로 기록하는 것:
   - 공급자 식별 칸의 위치와 미리 채워졌는지(값 없이)
   - 공급받는자 이메일 칸의 위치와 필수 여부
   - 발급 버튼의 이름과 위치. **누르지 않는다.**
   - 폼 요소 수와 버튼 종류(8절 스크립트 결과)
9. (선택) 이미 등록된 거래처가 있으면 yanggang이 거래처 '선택'만 해 본다.
   - 조회 창이 떠 있는 동안 Claude는 읽지 않는다.
   - 선택 뒤 이메일 칸이 채워졌는지는 yanggang이 '채워짐/비어 있음'으로 답한다.
   - 새 거래처 등록은 하지 않는다.
10. 화면을 떠날 때 저장 여부를 묻는 창이 뜨면 '취소' 또는 '아니오'를 누른다.

### C. 마무리

11. 정리한다.
    - yanggang이 홈택스의 '브라우저 인증서 삭제'로 브라우저에 저장된 인증서를 지운다.
    - 로그아웃하고 Chrome 창을 닫는다.
    - 테스트 프로필은 삭제한다. 다시 쓸 예정이면 yulmu와 정한다.
12. Claude가 기록 파일 두 개를 쓴다(7절).
    - `poc/reports/PoC-3-mac.md`
    - `poc/reports/raw/poc-3-mac-landmarks.json`
    - 가리기 전 메모는 저장소 밖, iCloud 동기화 밖의 로컬 폴더에 두고 2026-12-31에 지운다(D18 §4, ADR-025 결정 13의 맥 조건).
13. **커밋 전 확인(한 번).** yanggang에게 두 파일, 커밋 메시지, PR 본문을 보여 준다. 3절 6번 정보가 없는지 함께 확인하고, '커밋·PR·Bugbot 요청'을 한 번에 승인받는다.
14. 커밋하고 PR을 연다.
    - 브랜치 `poc/poc-3-mac-observe`, base `main`.
    - PR에 `bugbot run` 댓글을 단다.
    - 결과가 오면 지적을 검증해 고치거나, 근거를 답글로 단다. 답글과 보드 글도 3절 6번 기준을 지킨다.
    - CodeSolar 리뷰가 오면 그것도 대응하되, 따로 요청하지 않는다.
    - 30분이 지나도 Bugbot 결과가 없으면 보드에 그렇게 적고 마친다.
    - 머지는 yulmu가 한다.
15. 보드에 `board_post`로 status `review`, branch, pr, summary(5줄 이내)를 올린다.

## 7. 기록 형식

`poc/reports/raw/poc-3-mac-landmarks.json`:

```json
{
  "date": "2026-11-0X",
  "env": { "macos": "버전", "chrome": "버전" },
  "account": { "pocAccount": true, "certUse": "사업자범용 또는 전자세금계산서용" },
  "screens": [
    {
      "screen": "home.loggedIn",
      "path": "/websquare/websquare.html",
      "screenIds": { "w2xPath": "/ui/..." },
      "elements": [
        {
          "key": "form.counterpartEmail",
          "frame": "main",
          "role": "textbox",
          "name": "화면 라벨",
          "attrs": { "id": "", "name": "", "ariaLabel": "" },
          "required": false,
          "note": ""
        }
      ]
    }
  ],
  "stops": [{ "screen": "", "kind": "warning|queue|captcha|extra_auth|other", "text": "가린 문구" }]
}
```

- `screen`: 다음 값 중 하나를 쓴다.
  - `login.method`
  - `home.loggedIn`
  - `invoice.menu`
  - `invoice.issue`
  - `other.<이름>`
- `key`: 아는 것만 쓴다. `portal.ts`의 이름(예: `form.supplierBizNo`)을 따르고, 모르면 빈 문자열로 둔다.
- `role`: `button`·`link`·`textbox`·`combobox`·`checkbox`·`radio`·`tab`·`menuitem`·`status`·`form`·`dialog` 중 하나를 쓴다.
- `name`: 화면 라벨만 쓴다. 숫자나 고유명이 들어가면 `[값]`으로 바꾼다.
- `attrs`: 값이 아니라 속성 이름표다. 사람 이름이나 번호처럼 보이면 비운다.
- `stops[].text`: 식별 정보만 `[값]`으로 바꾸고 나머지 문구는 글자 그대로 둔다. 앱의 멈춤 신호는 화면 요소와 `^…$` 문구 패턴의 쌍이라(ADR-025 결정 2·3) 줄이거나 바꿔 쓰면 쓸 수 없다.

`poc/reports/PoC-3-mac.md`의 절:

1. 환경
2. 로그인 흐름 표(S1b): 단계, 보인 선택지, 사람 조작, 걸린 시간
3. 보안 프로그램·가상키패드(`PoC-1.md` §4 표 형식)
4. 건별발급까지의 메뉴 경로
5. 이메일 칸·공급자 칸·발급 버튼·폼 구조
6. 멈춤 신호(없으면 "없음")
7. 막힌 점
8. Windows 실측(PoC-3)에 넘길 것(ADR-025 '후속'의 S1 산출물 목록과 대조: 로그인 경로 집합, 멈춤 문구)

## 8. 구조 확인 스크립트(값을 읽지 않음)

`javascript_tool`에는 아래 스크립트만 그대로 넣는다. 입력값·비밀번호 칸·숨은 칸은 읽지 않는다. 같은 출처의 iframe만 본다. 결과에 `truncated: true`가 있으면 그 화면은 앞의 150개만 기록하고, `note`에 '요소 많음, 앞 150개만'이라고 적는다. 스크립트는 바꾸지 않는다.

```js
(() => {
  const pick = (e) => ({
    tag: e.tagName.toLowerCase(),
    type: e.getAttribute('type') || '',
    role: e.getAttribute('role') || '',
    id: e.id || '',
    name: e.getAttribute('name') || '',
    ariaLabel: e.getAttribute('aria-label') || '',
    required: e.required === true || e.getAttribute('aria-required') === 'true',
    inForm: !!e.closest('form'),
  });
  const sel = 'input:not([type=hidden]):not([type=password]), select, textarea, button, [role=button], [role=tab], [role=menuitem]';
  const scan = (doc, frame) => {
    const all = [...doc.querySelectorAll(sel)];
    return { frame, forms: doc.querySelectorAll('form').length, total: all.length, truncated: all.length > 150, elements: all.slice(0, 150).map(pick) };
  };
  const out = [scan(document, 'main')];
  document.querySelectorAll('iframe').forEach((f, i) => {
    const frame = f.getAttribute('name') || f.id || `iframe${i}`;
    try { out.push(f.contentDocument ? scan(f.contentDocument, frame) : { frame, unreadable: true }); } catch { out.push({ frame, unreadable: true }); }
  });
  return out;
})()
```

## 9. 승인이 필요한 때

| 단계 | 누가 승인 |
|---|---|
| 시작 가능 | yulmu, 보드 스레드 |
| 시간 겹침 없음 | yulmu, 보드 스레드 |
| GitHub 로그인 | yanggang |
| 확장 설치·사이트 허용 | yanggang |
| 시작 전(5절 6) | yanggang |
| 보안 프로그램 설치 | yulmu가 판단, yanggang이 설치 |
| 멈춤 | 알림만, 재개는 yulmu |
| 커밋·PR·Bugbot 요청(6절 13) | yanggang, 한 번 |
