# 시험용 한글 글꼴(OCR 입력 렌더링)

`tests/ocr.test.ts`가 Chrome으로 그리는 합성 사업자등록증은 이 글꼴로만 그린다(`tests/kor-font.ts`).
OS 글꼴(Apple SD Gothic Neo·Malgun Gothic·러너에 깔린 Noto CJK·WenQuanYi 등)에 따라 획이 달라져
tesseract kor가 "월드컵로"를 "월드컴로"로 읽는 식으로 결과가 OS·컨테이너마다 흔들렸기 때문이다.

- `NotoSansKR-Regular.subset.woff2`, `NotoSansKR-Bold.subset.woff2`: Noto Sans KR 2.004(Adobe·Google, SIL OFL 1.1, `OFL.txt`)의 부분 집합.
- 글자: ASCII(U+0020–007E), KS X 1001 완성형 한글 2,350자, 몇 가지 문장 부호(U+00A0·00B7·2010·2013·2014·2018·2019·201C·201D·2026·203B·3000–3002). 2,459자.
- 원본: npm `@expo-google-fonts/noto-sans-kr@0.4.4`의 `400Regular/NotoSansKR_400Regular.ttf`(sha256 `b4a747e7…eef4`)·`700Bold/NotoSansKR_700Bold.ttf`(sha256 `c76f806d…e9cc`).

시험 견본에 완성형 밖 글자를 넣으면 `kor-font.ts`가 "글꼴에 없는 글자"로 바로 실패한다. 그때는 아래처럼 다시 만든다(fonttools 4.68).

```sh
python3 - <<'EOF'
cs = set(range(0x20, 0x7f)) | {0xa0, 0xb7, 0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x203b, 0x3000, 0x3001, 0x3002}
for hi in range(0xb0, 0xc9):
    for lo in range(0xa1, 0xff):
        try: cs.add(ord(bytes([hi, lo]).decode('euc-kr')))
        except UnicodeDecodeError: pass
open('unicodes.txt', 'w').write(','.join('U+%04X' % c for c in sorted(cs)))
EOF
pyftsubset NotoSansKR_400Regular.ttf --unicodes-file=unicodes.txt --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file=NotoSansKR-Regular.subset.woff2
pyftsubset NotoSansKR_700Bold.ttf    --unicodes-file=unicodes.txt --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file=NotoSansKR-Bold.subset.woff2
```
