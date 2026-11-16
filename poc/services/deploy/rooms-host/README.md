# 룸 호스트: AWS Lightsail 서울 VM 한 대

`rooms.tax.laf-co.com`은 폰↔PC 릴레이의 WSS 쪽이다. 1회용 페어링 룸(`RELAY_ROOMS=1`)과 라이브 우편함(`RELAY_LIVE`)을 받는다.
Vercel 함수는 WebSocket을 받지 못하고 룸은 메모리에 있어서, 상시 컨테이너 **한 대**가 필요하다(../README.md 1절·3절 5번).

구성: Ubuntu VM + Docker. `compose.yml`이 릴레이 컨테이너(`services/relay/Dockerfile`)와 Caddy(TLS 자동 발급, WSS 프록시)를 띄운다.
배포는 GitHub Actions `rooms-host-deploy`(수동 실행)가 한다: 러너에서 이미지를 빌드해 VM으로 옮기고 갈아 끼운 뒤 공개 스모크를 돈다.

| 파일 | |
|---|---|
| `compose.yml` | 릴레이 + Caddy. 역할 고정값(룸 켬, 마이그레이션 안 함, origin 둘)은 여기, 비밀은 VM의 `relay.env`에만 |
| `Caddyfile` | `rooms.tax.laf-co.com` TLS → `relay:8083`. 릴레이가 아는 경로만 넘기고 나머지는 404. 접근 로그 없음 |
| `relay.env.example` | `relay.env`에 넣을 **이름만**(값 없음) |
| `remote-apply.sh` | VM에서 이미지 읽기 → `docker compose up -d` → healthy 확인 |

## 비용·리전

- Lightsail Linux 인스턴스(공개 IPv4 포함) 가장 작은 요금제부터 월 약 5~7달러. 서울(`ap-northeast-2`). SES와 같은 AWS 계정이다.
- AWS는 외국 법인이라 처리방침에는 "국외 이전 가능"으로 적는다(D09 §1, Supabase·Vercel과 같은 취급). 이 호스트가 보는 것은 릴레이 README의 "침해되면 무엇이 새는가"와 같다(암호문 프레임, 접속 IP, 시각).

## 사용자가 한 번 할 일

1. **인스턴스 만들기**: Lightsail 콘솔 → 리전 서울 → Linux/Unix, OS Only **Ubuntu 24.04 LTS** → 1GB RAM 이상 요금제 → 이름 `sax-rooms`.
   - Networking 탭: **고정 IP(Static IP)** 를 만들어 붙인다. IPv4 방화벽은 **22(SSH), 80, 443**만 연다. 22는 가능하면 "Restrict to IP"를 쓰되, GitHub Actions 러너 IP가 고정이 아니라 배포 때만 열어 둬도 된다.
2. **VM 준비**(브라우저 SSH로 한 번):
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
   sudo usermod -aG docker ubuntu
   sudo install -d -o ubuntu -g ubuntu -m 750 /opt/sax-rooms /opt/sax-rooms/incoming
   # 배포 전용 SSH 키(공개키만 VM에): 로컬에서 ssh-keygen -t ed25519 -f sax-rooms-deploy -N '' 로 만들고 .pub 내용을 붙인다
   echo 'ssh-ed25519 AAAA... sax-rooms-deploy' >> ~/.ssh/authorized_keys
   # 서비스 비밀: relay.env.example의 이름에 값을 채워 붙여 넣는다(값은 비밀번호 관리자에서, Vercel RELAY__* 와 같은 값)
   install -m 600 /dev/null /opt/sax-rooms/relay.env && nano /opt/sax-rooms/relay.env
   ```
   한 번 로그아웃했다 들어오면 `docker` 그룹이 적용된다.
3. **DNS(GoDaddy)**: `rooms.tax` A 레코드 = 1번의 고정 IP. TTL 600.
4. **GitHub**: 저장소 Settings → Environments → `rooms-prod`를 만들고(배포 승인자 지정 권장) 비밀 셋을 넣는다.
   - `ROOMS_HOST`: 고정 IP
   - `ROOMS_SSH_KEY`: 2번에서 만든 개인키 파일 내용 전체
   - `ROOMS_KNOWN_HOSTS`: 로컬에서 `ssh-keyscan -t ed25519 <고정 IP>` 출력 한 줄
5. **Vercel env**: `ACCOUNT__STOP_HOOK_URLS`·`ACCOUNT__RELAY_INTERNAL_URL` = `https://rooms.tax.laf-co.com`(이미 이 값이면 그대로). 바꿨으면 재배포.
6. Actions → `rooms-host-deploy` → Run workflow(main). 끝에 `https://rooms.tax.laf-co.com/healthz`가 `{"ok":true}`, 인증 없는 `POST /v1/rooms`가 401이면 성공이다.

## 라이브 우편함(`RELAY_LIVE`, 기본 켬)

집에 둔 PC와 밖의 폰이 사진·현금매출을 바로 주고받는 길이다. 한쪽이 꺼져 있으면 HTTPS 큐로 돌아가고, PC가 다시 붙으면 서버가 `{"t":"env"}`로 바로 알려 준다.
- 클라이언트는 라이브 WSS의 DPoP `htu`를 QR의 릴레이 호스트(`https://rooms.tax.laf-co.com/v1/mailboxes/:id/live`)로 만든다. `compose.yml`의 `RELAY_WS_ORIGIN`이 그 값이라 맞는다(../README.md "알려진 차이" 8번).
- 연결 유지: 클라이언트가 30초마다 텍스트 `{"t":"ping"}`을 보내고 릴레이가 `{"t":"pong"}`으로 답한다. 75초 동안 아무것도 못 받으면 클라이언트가 끊고 1초부터(최대 30초) 다시 붙는다. 집 공유기 NAT가 조용히 연결을 버려도 1분 남짓이면 다시 붙는다.
- 비상시 끄기: `printf 'SAX_RELAY_LIVE=0\n' >> /opt/sax-rooms/.env && docker compose up -d`. 큐로만 돈다(최대 30초 늦음).
- 확인: PC에서 폰을 연결하고 사진을 한 장 보낸다. 릴레이 로그(`docker compose logs relay`)에 `/v1/mailboxes/:id/live` 101이 PC·폰 두 번 남는다.

## 운영 메모

- 재시작하면 진행 중인 페어링(120초 룸)만 다시 하면 된다. 라이브 연결은 클라이언트가 다시 붙는다.
- 로그: `docker compose logs --tail 100 relay`. 라우트 패턴·상태만 남는다(우편함 ID·IP 없음).
- 롤백: Actions에서 이전 main 커밋을 고를 수 없으므로 VM에서 `sed -i 's/^SAX_RELAY_TAG=.*/SAX_RELAY_TAG=<이전 태그>/' .env && docker compose up -d`(이전 이미지 둘을 남겨 둔다).
- 침해 대응은 ../../relay/README.md(큐 전면 폐기 + 우편함 재발급)와 같다. VM은 Lightsail 스냅샷 없이 다시 만들 수 있다(상태가 없다).
