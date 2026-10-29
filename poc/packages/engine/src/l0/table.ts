// S-L0 규칙 대체 표(번들 질문 전수). 보고서 reports/S-L0.md의 원천이고, 번들 질문과 1:1인지 테스트가 확인한다.
// r8: R8 §5.3 추정. mode: both = 규칙이 양쪽 값을 낼 수 있음, stop = 중단 쪽 값만(비가역 직전·직후·보안·안전 번들, judge가 강제), none = 규칙 없음.

export interface L0Row {
  bundle: string;
  question: string;
  r8: '높음' | '중간' | '낮음' | '삭제됨';
  mode: 'both' | 'stop' | 'none';
  signal: string;
  /** 승격 시 호출 절감. 규칙 전용 결정은 매핑이 참조하는 모든 질문에 규칙 답이 있을 때만(judge.ts requiredForRulesOnly) */
  callSaving: string;
}

export const L0_TABLE: L0Row[] = [
  { bundle: 'screen_state_v2', question: 'screen', r8: '중간', mode: 'stop', signal: '제목·heading 사전(차단·점검 안내), 로그인 버튼+인증 탭+로그아웃 없음', callSaving: '없음: 매핑이 참조하는 다른 7문항이 남아 모델 호출(규칙 답은 덮어쓰기)' },
  { bundle: 'screen_state_v2', question: 'security_warning', r8: '중간', mode: 'stop', signal: '비정상 접근·이용 제한·매크로 문구 사전', callSaving: '없음(덮어쓰기만): 있음이면 모델 답과 무관하게 blocked' },
  { bundle: 'screen_state_v2', question: 'logged_out_by_other_session', r8: '높음', mode: 'stop', signal: '중복 로그인 종료 문구', callSaving: '없음(덮어쓰기만)' },
  { bundle: 'screen_state_v2', question: 'captcha_visible', r8: '높음', mode: 'stop', signal: 'img+textbox 이름에 보안문자·자동입력 방지', callSaving: '없음(덮어쓰기만)' },
  { bundle: 'screen_state_v2', question: 'mfa_pending', r8: '높음', mode: 'stop', signal: '인증 앱·휴대폰 인증 대기 문구', callSaving: '없음(덮어쓰기만)' },
  { bundle: 'screen_state_v2', question: 'session_expired_notice', r8: '높음', mode: 'stop', signal: '세션 만료·재로그인 문구', callSaving: '없음(덮어쓰기만)' },
  { bundle: 'screen_state_v2', question: 'has_error_modal', r8: '높음', mode: 'stop', signal: 'dialog·alertdialog·alert + 오류 키워드', callSaving: '없음(덮어쓰기만)' },
  { bundle: 'screen_state_v2', question: 'issuance_success_text', r8: '높음', mode: 'stop', signal: '완료 문구 + 승인번호 정규식(로컬 원문)', callSaving: '없음(매핑에 쓰이지 않음, 확정은 verify)' },
  { bundle: 'screen_state_v2', question: 'page_text_addresses_agent', r8: '낮음', mode: 'none', signal: '결정적 사전 필터는 별도(injection-filter.ts), predicate는 모델 필수', callSaving: '—' },
  { bundle: 'popup_class_v1', question: 'popup', r8: '중간', mode: 'stop', signal: '모달 본문 사전(보안·보안문자·세션·동의·오류), notice_dismissable은 규칙이 내지 않음', callSaving: 'popup·asks 둘 다 규칙 답(중단 쪽)이 있을 때만 호출 생략' },
  { bundle: 'popup_class_v1', question: 'asks_to_proceed_or_issue', r8: '중간', mode: 'stop', signal: '모달 안 확정 버튼 이름(발급·신청·제출·전송·서명·예)', callSaving: 'popup과 함께 답할 때만 호출 생략, 아니면 덮어쓰기(notice_dismissable 배제)' },
  { bundle: 'recovery_v1', question: 'situation', r8: '중간', mode: 'both', signal: 'URL 경로·heading을 체크포인트 기대값과 비교, 모달 존재, 세션 문구', callSaving: '단일 질문 번들이라 승격 시 호출 생략' },
  { bundle: 'form_ready_v2', question: 'validation_error_visible', r8: '높음', mode: 'stop', signal: 'invalid 상태, alert·모달 오류 문구', callSaving: '오류 있음일 때 호출 생략, 없음은 모델+결정적 assert+readback' },
  { bundle: 'form_ready_v2', question: 'required_fields_filled', r8: '삭제됨', mode: 'none', signal: '번들에서 삭제(B-34). 엔진 결정적 assert(모든 fieldKey non-empty)가 대체', callSaving: '모델 질문 자체 없음' },
  { bundle: 'issue_result_v2', question: 'result', r8: '중간', mode: 'stop', signal: '중복·반려·서명 대기 문구, issued는 규칙이 내지 않음(확정은 verify)', callSaving: '단일 질문 번들: 중단 쪽 분류일 때 호출 생략' },
  { bundle: 'intent_route_v1', question: 'playbook', r8: '낮음', mode: 'both', signal: '서류·작업 사전 15군(정확히 1군 일치, 세무 키워드 없음)', callSaving: '없음: 같은 번들의 mentions_tax_advice가 모델 필수' },
  { bundle: 'intent_route_v1', question: 'mentions_tax_advice', r8: '낮음', mode: 'none', signal: '키워드 휴리스틱은 위양성(R8)', callSaving: '—' },
  { bundle: 'amount_parse_check_v1', question: 'parse_matches_user_text', r8: '높음', mode: 'both', signal: '파서와 독립된 금액 재추출(숫자·단위·한글 숫자) + 공급가+세액=합계 산술', callSaving: '단일 질문 번들이라 승격 시 호출 생략' },
  { bundle: 'doc_meta_check_v1', question: 'issued_on', r8: '높음', mode: 'both', signal: '후보 문맥 사전(발급일·발행일), 후보 0개면 none', callSaving: '두 질문 모두 승격 시 호출 생략' },
  { bundle: 'doc_meta_check_v1', question: 'valid_until', r8: '높음', mode: 'both', signal: '후보 문맥 사전(유효기간·까지 유효), 후보 0개면 none', callSaving: '두 질문 모두 승격 시 호출 생략' },
];
