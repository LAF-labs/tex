# 계정 서비스 데이터

## `common-passwords.txt.gz`

유출·흔한 비밀번호 목록이다(ADR-038 (c), D09 §2.1). 한 줄에 하나이고 gzip이다. 서버는 NFKC 소문자로 비교한다(`src/password.ts` `CommonPasswords`). 외부 호출은 없다.

- 출처: [SecLists](https://github.com/danielmiessler/SecLists) `Passwords/Common-Credentials/10-million-password-list-top-100000.txt`
  - 커밋 고정본: `2d5dc7504a40962c53f932a6d9d5ece4b213dfc6`(이 경로가 있는 마지막 커밋. 다음 커밋 `4ff3ff8`이 같은 내용의 `xato-net-10-million-passwords-100000.txt`와 중복이라 지웠다)
  - 원본 URL: `https://raw.githubusercontent.com/danielmiessler/SecLists/2d5dc7504a40962c53f932a6d9d5ece4b213dfc6/Passwords/Common-Credentials/10-million-password-list-top-100000.txt`
  - git blob: `3e24a14102e0f1e7985bdb044069090b001d89b5`(GitHub contents API 값과 같음)
  - 원본 SHA-256: `e30e15faecc8db2d3181c3126e3b2c0cd5c187af10a5e4e83babfa157edab188`(781,959바이트, 100,007줄, ASCII, LF)
  - 받은 날: 2026-11-06(사용자 승인, 팀장 전달. 승인 범위는 이 파일 하나)
- 저장: 원본을 바꾸지 않고 `gzip -9 -n`으로만 묶었다(374,168바이트). 풀면 위 SHA-256과 같다. 시험(`tests/services-account-password.test.ts`)이 이 값을 고정한다.
- 10자 미만 항목은 길이 규칙이 먼저 거부하므로 쓰이지 않는다(10자 이상은 2,344개). 원본 대조를 위해 빼지 않았다.
- 바꿀 때: 같은 방식(커밋 고정본, 원본 그대로 gzip)으로 받고 이 문서의 커밋·SHA-256과 시험 값을 함께 바꾼다.

### 고지(MIT)

SecLists는 MIT 라이선스다(라이선스 원문: 위 커밋의 `LICENSE`).

```
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
