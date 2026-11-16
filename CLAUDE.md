<!-- artiboard:start -->
## Task board
Tasks, threads and notices: https://project.laf-co.com/p/tex (MCP `artiboard`). For board work (finding, claiming, continuing or finishing a task, posting a notice), call `board_start {project: "tex"}` first: it gives the board rules, this project's rules and your work.
<!-- artiboard:end -->

## 코드 찾기
파일·심볼·호출 관계를 찾을 때는 grep이나 파일 통째 읽기 전에 artiboard `board_map {project: "tex"}`(query·file·impact·inside)를 먼저 쓴다. 지도는 main 기준이고 main에 푸시될 때마다 CI가 갱신한다. 고치기 전에는 내 체크아웃의 실제 파일을 읽어 확인한다.

## 작업 방식
- 어디서 할지: 미리보기가 필요 없는 일(조사·문서·백엔드·CI)은 클라우드, 화면·문구·레이아웃·실화면 예행·서명 빌드는 맥북 원격 세션. 대표가 "맥북으로/클라우드로"라고 하면 따르고, 애매하면 시작 전에 추천과 함께 묻는다.
- 시작 전에 읽기: 인계 `sovereign-ax/handover/2026-11-16-projects.md`(무엇을), 작업 방식 노트 `sovereign-ax/handover/working-notes.md`(어떻게, 겪은 마찰과 처방).
- 대표 몫(본인 인증·[승인]·권한 허용·결정)은 모아서 한 번에 묻는다. 맥북 일은 노트 2절 사전 점검부터.
- 매일 점검 기록은 `sovereign-ax/handover/retro/`에 남긴다. 새로 배운 규칙은 노트로 옮긴다.
