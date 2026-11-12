<!-- artiboard:start -->
## Task board
Tasks, threads and notices: https://project.laf-co.com/p/tex (MCP `artiboard`). For board work (finding, claiming, continuing or finishing a task, posting a notice), call `board_start {project: "tex"}` first: it gives the board rules, this project's rules and your work.
<!-- artiboard:end -->

## 코드 찾기
파일·심볼·호출 관계를 찾을 때는 grep이나 파일 통째 읽기 전에 artiboard `board_map {project: "tex"}`(query·file·impact·inside)를 먼저 쓴다. 지도는 main 기준이고 main에 푸시될 때마다 CI가 갱신한다. 고치기 전에는 내 체크아웃의 실제 파일을 읽어 확인한다.
