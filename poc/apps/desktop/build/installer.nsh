; NSIS 추가 스크립트(D14 M4-9). electron-builder nsis.include로 들어간다.
; 설치 경로: 사용자별 %LOCALAPPDATA%\Programs\<productName>(electron-builder 기본값, 관리자 권한 없음).
; 데이터 루트 %LOCALAPPDATA%\SovereignAX(D07 §1.1: DACL 소유자 + SYSTEM·상속 차단·검색 색인 제외, 앱이 매 기동 확인)와 나눈다.
; 이 파일은 설치 경로가 데이터 루트 안으로 들어가는 것(/D 스위치·이전 설치 기록)만 막는다. 데이터 폴더는 만들거나 지우지 않는다.

!macro customInit
  ; initMultiUser가 $INSTDIR을 정한 뒤 불린다
  StrCpy $R8 "$LOCALAPPDATA\SovereignAX"
  StrLen $R9 $R8
  StrCpy $R7 $INSTDIR $R9
  ${If} $R7 == $R8
    ; 바로 뒤 글자가 없거나 \ 이면 데이터 루트 자신이거나 그 아래다(SovereignAXfoo 같은 이웃 폴더는 통과)
    StrCpy $R6 $INSTDIR 1 $R9
    ${If} $R6 == ""
    ${OrIf} $R6 == "\"
      MessageBox MB_ICONSTOP|MB_OK "프로그램을 데이터 폴더($R8) 안에 설치할 수 없습니다." /SD IDOK
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; 데이터 폴더(%LOCALAPPDATA%\SovereignAX: DB·서류 보관함·전용 Chrome 프로필)는 남긴다(deleteAppDataOnUninstall: false와 같은 뜻).
  ; 지우는 것은 사용자가 앱 안에서 고른다(D07, Phase 1 범위 밖).
!macroend
