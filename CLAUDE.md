<!-- artiboard:start -->
## Task board
Tasks, threads and notices: https://project.laf-co.com/p/tex (MCP `artiboard`). For board work (finding, claiming, continuing or finishing a task, posting a notice), call `board_start {project: "tex"}` first: it gives the board rules, this project's rules and your work.
<!-- artiboard:end -->

## 코드 찾기
파일·심볼·호출 관계를 찾을 때는 grep이나 파일 통째 읽기 전에 artiboard `board_map {project: "tex"}`(query·file·impact·inside)를 먼저 쓴다. 지도는 main 기준이고 main에 푸시될 때마다 CI가 갱신한다. 고치기 전에는 내 체크아웃의 실제 파일을 읽어 확인한다.

## 작업 방식
- 시작 전에 `sovereign-ax/handover/working-notes.md` 1절 규칙을 읽는다. 대표가 개입하거나 지적했던 일에서 나온 규칙이다. 인계 문서 `sovereign-ax/handover/2026-11-16-projects.md`는 무엇을 하는지 적은 문서다.
- 어디서 할지: 미리보기가 필요 없는 일(조사·문서·백엔드·CI)은 클라우드, 화면·문구·레이아웃·실화면 예행·서명 빌드는 맥북 원격 세션. 대표가 "맥북으로/클라우드로"라고 하면 따르고, 그 밖에는 묻지 않고 이 기준으로 정해 바로 시작한다(맥북 원격 세션 열기는 승인 대상이 아니다, 11-19).
- 묻기 전에 스스로 찾고, 대표 몫(인증·[승인]·권한·결정)은 모아서 한 번에 묻는다. 위임받은 일은 다시 승인받지 않는다.
- 대표가 새로 개입하거나 지적하면, 그 스레드가 노트 2절에 기록하고 1절 규칙을 고친다. 매일 점검이 빠진 것을 채운다(`sovereign-ax/handover/retro/`).
