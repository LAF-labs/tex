# 린트 위반 예제(M1-1)

`tests/model-lint.test.ts`가 각 `.ts.txt`를 머리말의 `as:` 경로에 있는 파일인 것처럼 ESLint로 검사하고,
`expect:`의 규칙별 오류 수와 정확히 같은지 본다. 확장자가 `.txt`라 `pnpm lint`(eslint .)는 이 파일들을 읽지 않는다.

- `as:` 가짜 파일 경로(규칙 범위가 경로로 정해진다)
- `expect:` `규칙ID=개수`를 쉼표로. `none`이면 오류가 없어야 한다.
