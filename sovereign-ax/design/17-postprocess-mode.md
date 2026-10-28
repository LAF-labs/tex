# D17. 후처리(guide) 모드 명세 (초안)

> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영: docparse를 Chromium 렌더러 샌드박스로(ADR-014), 다운로드 폴더 자동 파싱 축소, `shell.openExternal` 호출 주체·스킴·호스트 규칙, 복사 버튼 클립보드 기록 제외, 비밀 단계의 복사 버튼 변환 금지, 메타데이터 후보 선택형.

MVP의 정부24 서류 3종은 모두 이 모드로 출시된다. 원칙: **Chrome·CDP를 띄우지 않고, 포털에 어떤 요청도 보내지 않는다.** 사용자가 기본 브라우저에서 직접 발급하고, 하네스는 안내·파일 수집·메타데이터·만료 추적만 한다.

## 1. 흐름

1. 사용자가 작업 카드(예: 주민등록등본)를 누른다 → 하네스가 기본 브라우저로 포털을 연다(1회, §1.1 규칙). 동시에 안내 패널을 띄운다.
2. 안내 패널: 플레이북 `guide` 변환본의 체크리스트(로그인 → 메뉴 → 입력 → 발급 → 출력), 각 단계의 입력값 복사 버튼(사업자번호·주소 등 비밀 아닌 값만, §1.2 규칙), "출력/저장했어요" 버튼.
3. 파일 감시: 다운로드 폴더, 인쇄 출력 폴더(Microsoft Print to PDF 기본 경로), 사용자가 지정한 폴더를 감시한다. 작업 시작 이후 생성된 PDF만 **후보 목록**에 올린다. 후보는 사용자가 "이 파일이 맞아요"로 고르기 전까지 **파싱하지 않는다**(§1.3). 정부24+ 비밀번호 PDF는 사용자가 비밀번호를 입력해 열고(비밀번호는 저장하지 않음, 복호화는 docparse 샌드박스 안에서) 복호화 사본을 보관함에 둔다.
4. 매칭: 사용자가 고른 PDF를 `docparse`(Chromium 렌더러 샌드박스, §3)로 추출해 서류 종류 키워드·발급일·성명/상호 일치로 현재 작업과 맞는지 확인한다. 어긋나면 사용자에게 "이 파일이 맞나요?"를 다시 묻는다. 후보가 없으면 `postprocess.file_not_detected`로 수동 선택.
5. 메타데이터: 발급일·유효기간을 규칙으로 추출한다. 규칙 추출기가 날짜 후보를 만들고 `doc_meta_check_v1`은 마스킹 후 **후보 중에서 고르기만** 한다(D04 §3). 선택값이 서류 종류 규칙표와 30일 넘게 차이 나면 사용자 확인 없이 확정하지 않는다. 실패하면 수동 입력 폼(날짜 2개).
6. 보관: `%LOCALAPPDATA%\SovereignAX\vault\{docType}_{yyyyMMdd}_{shortId}.pdf`로 이동(원본은 사용자 선택: 삭제/유지), DB 등록, 만료 규칙 적용, 백업 큐. 사용자가 보관함 폴더를 바꾼 경우의 파일 시스템·ACL 점검은 D07 §1이 정한다.
7. 완료·타임아웃·취소: "출력했어요" 후 2분 내 후보 미감지 → 수동 선택 안내. 30분 무활동 → 작업 자동 종료(기록만). 취소는 언제든.
8. 감사 로그: `run.started{mode: postprocess}`, `postprocess.file_detected{bytes, sha256}`, `artifact.saved`. 화면 텍스트·URL 없음.

### 1.1 외부 브라우저 열기 (A-17)

- `shell.openExternal`은 **main만** 호출한다. 렌더러(안내 패널)는 URL이 아니라 **키**(`portalId` 또는 strings 키)만 넘긴다.
- main은 키를 앱 내장 표에서 URL로 바꾸고, WHATWG 파싱 결과가 `https:` 스킴, userinfo·포트 없음, 호스트 ∈ 엔진 내장 eTLD+1 허용 목록(패키지로 변경 불가)일 때만 연다. 그 밖은 거부하고 `postprocess.open_denied`를 남긴다.
- guide 변환본(서명 패키지)에 있는 URL 문자열을 그대로 열지 않는다.

### 1.2 복사 버튼

- 클립보드에 쓸 때 기록·클라우드 제외 형식(`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0`, `CanUploadToCloudClipboard=0`)을 **같은 쓰기에** 포함한다. 30초 후 값이 그대로일 때만 클립보드를 비운다. Electron에서 사용자 정의 형식을 같은 쓰기로 넣을 수 있는지는 **S6l**, 불가하면 네이티브 헬퍼. (A-32)
- **guide 변환은 `secret_fill`·`human:secret` 스텝을 복사 버튼으로 만들지 않는다.** 해당 단계는 "포털 화면에 직접 입력하세요" 안내 문구만 표시한다. 변환 후 재검증에서 비밀 단계가 복사 버튼이 되면 오류다(V-20, A-05).

### 1.3 파일 감시와 자동 파싱 범위 (A-14)

- 자동 파싱 대상은 **staging(`%LOCALAPPDATA%\SovereignAX\staging\`, `auto`·`assisted` 모드에서 금고가 정한 다운로드·인쇄 경로)과 사용자가 고른 파일**뿐이다.
- 다운로드 폴더·인쇄 폴더·사용자 지정 폴더는 "작업 시작 후 생성 + 사용자 확인" 후보만 만든다. 웹사이트가 사용자 클릭 없이 떨어뜨린 PDF가 자동으로 파서에 닿는 경로를 없애기 위해서다.
- 후보 목록에는 파일명·크기·생성 시각만 보인다(파일 내용 미리보기는 사용자가 고른 뒤 샌드박스 추출 결과로만).

## 2. 금지와 테스트

- 이 모드에서 금고는 Chrome을 기동하지 않고, 엔진은 포털 호스트로 어떤 네트워크 요청도 보내지 않는다. 자동 테스트: 실행 중 Chrome 프로세스 0, CDP 0, 포털 호스트 요청 0, `openExternal` 1회.
- 추가 테스트: docparse 렌더러의 네트워크 요청 0(차단 세션 파티션), 사용자 확인 전 파싱 0건, `openExternal`에 비 https·허용 밖 호스트·userinfo·포트가 있는 URL 거부, 비밀 단계 복사 버튼 0개, 클립보드 쓰기에 제외 형식 포함.
- 캡차·간편인증은 사용자가 브라우저에서 직접 처리한다. 폰 중계 없음.
- 화면 읽기(접근성 트리·스크린샷) 없음. 모델 호출은 저장된 PDF의 메타데이터 후보 선택뿐.

## 3. docparse 인터페이스와 격리 (ADR-014)

```ts
interface DocParse {
  extract(bytes: Uint8Array, opts: {maxPages: 5; password?: Uint8Array}): Promise<{text: string; pages: number; hasTextLayer: boolean}>;
  ocr(bytes: Uint8Array, lang: 'kor'): Promise<{text: string}>;
  certInfo(der: Uint8Array): Promise<{subject: string; issuer: string; notBefore: string; notAfter: string}>;   // NPKI signCert.der 전용(D05 §6)
}
```

- **격리**: docparse는 **Chromium 렌더러 샌드박스 안**에서 돈다. 숨김 `BrowserWindow`(`sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`), **네트워크를 차단한 전용 `session` 파티션**(모든 요청 취소, 권한 요청 전부 거부), preload는 MessagePort 수신만 노출한다. pdf.js와 tesseract.js(wasm)를 그 안에 둔다. 이전 판의 "별도 무권한 프로세스(utilityProcess)"는 샌드박스가 아니라 Node가 켜진 사용자 권한 프로세스였으므로 대체한다(A/C-06).
- **입출력**: 입력은 파일 핸들이 아니라 main이 읽은 **바이트**다. 출력은 main이 JSON Schema(`{text: string ≤ 1MB, pages: integer ≤ 5, hasTextLayer: boolean}`, `certInfo`는 고정 4필드)로 검증한 뒤에만 쓴다. 스키마 밖 출력은 버리고 실패 코드로 처리한다.
- **pdf.js 설정**: `isEvalSupported:false`, 버전 고정, 월 1회 취약점 공지 점검. 처리 시간·메모리 상한을 두고 넘으면 창을 파기한다. 작업마다 새 창을 만들고 끝나면 파기한다.
- 성능·한글 추출률·메모리는 **S13b**에서 측정하고, AppContainer/Low IL 제한 토큰 별도 실행 파일을 대안으로 비교한다.
- 실패는 코드로만 보고한다(파일 내용·경로를 로그에 남기지 않음).

## 4. 사용자에게 보이는 문구

- 카드: "정부24에서 직접 발급하고, 저장된 파일은 제가 정리·추적합니다. 운영기관 허락이 확인되면 자동 발급으로 올라갑니다."
- 후보 확인: "작업을 시작한 뒤 새로 생긴 PDF입니다. 방금 발급한 파일을 골라 주세요."
- 설정 '운영 기준' 페이지에 포털별 수준과 공문 회신 상태.
