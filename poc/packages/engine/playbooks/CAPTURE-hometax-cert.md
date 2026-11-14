# 홈택스 즉시발급 민원증명(H-03·H-08·H-09) 실기기 캡처 목록

`scripts/playbooks/hometax-certificate.ts`가 만든다(손으로 고치지 않는다). 셀렉터는 실제 화면과 대조하지 않았다. 아래 항목을 실기기에서 캡처(접근성 트리·스크린숏·HAR)해 채운다.

2026-11-10 캡처(로그인 뒤 양식, 개인사업자 사업자 인증서)로 H-03·H-08의 칸 id·선택지·제출 버튼·메뉴 주소를 채웠다. 아래는 아직 남은 것이다.

공통 흐름에서 확인할 것:
- 민원증명 발급 로그인 수단(공동·금융인증서, 사업자용 간편인증 가능 여부, S16). 납세증명서·소득금액증명은 개인사업자 로그인으로 막힌다(대표자 개인 로그인 필요)
- 발급 버튼을 누른 뒤 확인 대화상자·전자서명 창이 뜨는지(뜨면 submit에 expectConfirm·signFlow를 더한다)
- 발급 요청의 `wqAction.do` actionId(HAR) → `commitEndpoints`
- 발급 실패 안내의 요소와 문구 → verify `failSignals`(지금은 H-01과 같은 자리표시 `#errorDialog`)
- PDF 경로: [출력]·[PDF 저장]·인쇄 대화상자 중 무엇이 되는지 → `save_pdf.strategy`(R2 §4는 과거 공식 「출력불가 프린터」)
- 발급 확인 조회는 `hometax.cert.issued_list`(H-04와 공유, LAF-labs/tex#247)다. 그 화면(민원신청 처리결과 조회)의 캡처는 그 패키지 몫이고, 여기서는 결과 표에 민원명·용도·제출처·발급번호 열이 보이는지만 같이 본다(verify match 키 certDoc·certPurpose·certSubmitTo, bind issueNo, H-04와 같음)

| 서류 | 셀렉터 | 캡처할 것 |
|---|---|---|
| H-03 | `hometax.cert.menu.civil` | 상단 메뉴 「증명·등록·신청」 링크의 접근성 이름(R2 §4) |
| H-03 | `hometax.cert.menu.issue` | 「민원증명(발급)」(또는 「즉시발급 증명」) 하위 메뉴 이름(02 §5.1·R2 §4 표기가 다르다) |
| H-03 | `hometax.cert.form.issueButton` | [작성완료]을 유효한 값으로 누른 뒤: 확인창·전자서명 창이 뜨는지, wqAction actionId(HAR → commitEndpoints). 접수가 실제로 생기므로 사용자 승인 뒤 |
| H-03 | `hometax.cert.alert` | 알림창(.w2window.w2popup_window.msg)의 접근성 역할·이름. 본문 「해당 화면은 개인사업자는 이용할 수 없습니다.」 |
| H-08 | `hometax.cert.form.issueButton` | [신청하기]을 유효한 값으로 누른 뒤: 확인창·전자서명 창이 뜨는지, wqAction actionId(HAR → commitEndpoints). 접수가 실제로 생기므로 사용자 승인 뒤 |
