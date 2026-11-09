# 홈택스 즉시발급 민원증명(H-03·H-08·H-09) 실기기 캡처 목록

`scripts/playbooks/hometax-certificate.ts`가 만든다(손으로 고치지 않는다). 셀렉터는 실제 화면과 대조하지 않았다. 아래 항목을 실기기에서 캡처(접근성 트리·스크린숏·HAR)해 채운다.

공통 흐름에서 확인할 것:
- 민원증명 발급 로그인 수단(공동·금융인증서, 사업자용 간편인증 가능 여부, S16)
- 발급 버튼을 누른 뒤 확인 대화상자·전자서명 창이 뜨는지(뜨면 submit에 expectConfirm·signFlow를 더한다)
- 발급 요청의 `wqAction.do` actionId(HAR) → `commitEndpoints`
- 발급 실패 안내의 요소와 문구 → verify `failSignals`(지금은 H-01과 같은 자리표시 `#errorDialog`)
- PDF 경로: [출력]·[PDF 저장]·인쇄 대화상자 중 무엇이 되는지 → `save_pdf.strategy`(R2 §4는 과거 공식 「출력불가 프린터」)
- 발급 확인 조회는 `hometax.cert.issued_list`(H-04와 공유, LAF-labs/tex#247)다. 그 화면(민원신청 처리결과 조회)의 캡처는 그 패키지 몫이고, 여기서는 결과 표에 용도·제출처·발급번호 열이 보이는지만 같이 본다(verify match 키 purpose·submitTo, bind issueNo)

| 서류 | 셀렉터 | 캡처할 것 |
|---|---|---|
| H-03 | `hometax.login.simpleAuthButton` | 민원증명 발급에 쓰는 로그인 수단: 공동·금융인증서 버튼 이름(사업자용 간편인증으로 발급되는지 S16, ADR-018 결정 10) |
| H-03 | `hometax.cert.menu.civil` | 상단 메뉴 「증명·등록·신청」 링크의 접근성 이름(R2 §4) |
| H-03 | `hometax.cert.menu.issue` | 「민원증명(발급)」(또는 「즉시발급 증명」) 하위 메뉴 이름(02 §5.1·R2 §4 표기가 다르다) |
| H-03 | `hometax.cert.menu.doc` | 「증명·등록·신청 > 민원증명(발급)」 아래 사업자등록증명 링크의 접근성 이름(R2 §4, 중간 신뢰) |
| H-03 | `hometax.cert.form.root` | 사업자등록증명 신청 양식의 form 랜드마크 이름 |
| H-03 | `hometax.cert.form.docName` | 양식에 보이는 서류 이름(민원명·증명서 종류) 칸. 승인 카드 첫 줄 「서류」 값이다(읽기 전용 표시일 수 있음) |
| H-03 | `hometax.cert.form.applicantBizNo` | 신청 양식에 보이는 내 사업자등록번호 칸(읽기 전용일 수 있음). 여러 사업장이면 「내 사업자 선택」 화면이 먼저 나오는지(R2 §4) |
| H-03 | `hometax.cert.form.applicantName` | 신청 양식의 상호(법인명) 칸 |
| H-03 | `hometax.cert.form.purpose` | 사용 용도 칸: 고르기(combobox)인지 직접 입력인지, 고를 수 있는 값 목록(R2 §4) |
| H-03 | `hometax.cert.form.submitTo` | 제출처 칸: 직접 입력인지 목록 선택인지, 글자 수 제한(R2 §4) |
| H-03 | `hometax.cert.form.rrnDisclosure` | 주민등록번호 공개 여부 칸의 역할(라디오·고르기)과 값 이름(「공개」·「비공개」 표기)(R2 §4) |
| H-03 | `hometax.cert.form.receiveMethod` | 수령 방법 칸과 값 이름(인터넷 발급(프린터 출력) 등). allowedConstants를 실제 값으로 |
| H-03 | `hometax.cert.form.issueButton` | 발급(신청) 버튼 이름(「발급하기」·「신청하기」·「열람」 중 무엇인지)과, 누른 뒤 확인 대화상자·전자서명 창이 뜨는지. 발급 요청의 wqAction actionId(HAR, commitEndpoints) |
| H-08 | `hometax.cert.menu.doc` | 부가가치세 과세표준증명 메뉴 링크 이름(면세사업자 수입금액증명과 같은 화면인지도) |
| H-08 | `hometax.cert.form.root` | 부가가치세 과세표준증명 신청 양식의 form 랜드마크 이름 |
| H-08 | `hometax.cert.form.periodFrom` | 과세기간 시작(연·월 또는 연·기 선택) 칸의 역할·이름·값 형식(신고가 끝난 과세기간만 고를 수 있음, R10) |
| H-08 | `hometax.cert.form.periodTo` | 과세기간 끝 칸의 역할·이름·값 형식 |
| H-09 | `hometax.cert.menu.doc` | 표준재무제표증명(개인·법인) 메뉴 링크 이름. 개인·법인이 다른 메뉴인지 |
| H-09 | `hometax.cert.form.root` | 표준재무제표증명 신청 양식의 form 랜드마크 이름과, 신고 미반영으로 발급이 안 될 때의 안내 문구 |
| H-09 | `hometax.cert.form.fiscalYear` | 귀속연도(또는 사업연도) 칸의 역할·이름·값 형식. 신고가 전산에 반영되지 않은 해는 목록에 없을 수 있음(R10) |
