# ADR-039. Windows 폴더 소유자 확인을 폴더마다 프로세스당 한 번으로

> 상태: 채택(팀장 지시 2026-11-06, WIN-REALDEVICE §6.1 후속) · Phase 1. D07 §1.1·D05 §3.1의 "매 기동 확인"에서 소유자 읽기 빈도만 바꾼다. DACL 확인·복구 규칙은 그대로다.
> 관련: D07 §1.1, D05 §3.1·§3.6, [poc/reports/WIN-REALDEVICE.md](../../../poc/reports/WIN-REALDEVICE.md) §6.1, PoC-1 S6m

## 맥락

- `WindowsDirGuard.checkPrivate`는 폴더를 볼 때마다 두 가지를 읽는다.
  - DACL: `icacls /save`.
  - 소유자 SID: `powershell.exe Get-Acl`. `icacls /save`에는 소유자가 없어서 PowerShell을 쓴다.
- 앱 기동 때 1번, 금고가 Chrome을 띄울 때마다 2번(앱 루트·전용 프로필) 부른다.
- PoC-1 PC에서 PowerShell 기동은 약 0.3초였다. 느린 Windows 실기기에서는 Chrome 하나가 떠 있는 상태로 3.4~15.2초였다. `pnpm test` 부하에서는 읽기 도구 상한 30초를 넘어 죽었고, 금고의 Chrome 기동이 실패했다(WIN-REALDEVICE §6.1).
- PowerShell 없이 소유자를 읽는 기본 도구가 없다.
  - `icacls`에는 소유자 출력이 없다.
  - `dir /q`는 이름을 콘솔 코드 페이지로, 그것도 잘라서 보인다.
  - `wmic`은 Windows 11에서 빠지는 중이다.
- 네이티브 헬퍼(`GetNamedSecurityInfoW`)는 아직 없다. 금고 네이티브 헬퍼(S10c·W-2·W-4)와 함께 들어올 예정이다.

## 결정

1. **신뢰 소유자로 확인한 폴더는 같은 폴더인 동안 프로세스 안에서 다시 읽지 않는다**(`OwnerMemo`, `packages/platform/src/acl.ts`).
   - 같은 폴더의 기준은 `lstat`(bigint)의 볼륨(`dev`)·파일 ID(`ino`)·생성 시각(`birthtimeNs`)이다.
   - 지우고 같은 이름으로 다시 만들면 다른 폴더로 보고 다시 읽는다.
   - 파일 ID를 주지 않는 파일 시스템(0)·링크·파일이면 기억하지 않는다.
   - 신뢰 소유자(사용자·SYSTEM·Administrators, `isTrustedOwner`)만 기억한다. 남의 소유는 매번 다시 읽는다.
   - 읽기 실패, 읽는 동안 폴더 식별이 바뀐 경우도 기억하지 않는다.
   - 같은 폴더를 동시에 물으면 읽기 하나를 같이 기다린다.
   - 기억은 프로세스 메모리에만 둔다. 디스크에 두면 위조를 막을 서명 키가 플랫폼 패키지에 없다.
2. **DACL 확인은 지금처럼 매번 한다**(`icacls /save`, 상속 차단·사용자 전체 권한·사용자/SYSTEM 밖 주체 없음). 프로세스 사용자 SID(`whoami`)는 프로세스당 한 번 읽는다.
3. **소유자 읽기 상한을 90초로 따로 둔다**(`OWNER_TIMEOUT_MS`). 다른 읽기 도구는 30초 그대로다. 소유자 읽기는 폴더마다 프로세스당 한 번이라 느린 PC에서 실패하지 않는 쪽을 고른다.
4. **금고는 기동하자마자 앱 루트·전용 프로필 확인을 미리 한다**(Windows만, `Vault.warmDirChecks`).
   - 결과는 쓰지 않는다. Chrome을 띄울 때 다시 확인하고, 그때 소유자는 결정 1의 기억을 쓴다.
   - 걸린 시간만 `vault.dir_check_warm{ms, ok}`로 남긴다.

## 근거(왜 다시 읽지 않아도 판정이 같은가)

- 결정 2의 DACL이면 그 폴더에 ACE가 있는 주체는 사용자와 SYSTEM뿐이다. 이 DACL은 매 기동 확인한다.
- 소유자를 바꾸려면 둘 중 하나가 필요하다.
  - 그 폴더의 WRITE_OWNER 권한: 자기 자신이나 자기가 속한 그룹으로만 바꿀 수 있다.
  - 소유권 가져오기·복원 특권: 관리자.
- 그런데 결정 2의 DACL에서 WRITE_OWNER를 가진 것은 사용자·SYSTEM뿐이고, 특권은 관리자·SYSTEM에 있다. 셋 다 `isTrustedOwner`가 이미 믿는 쪽이다.
- 따라서 한 번 신뢰 소유자였던 폴더는, 신뢰하는 쪽이 하지 않는 한 남의 소유가 되지 않는다.
- 남의 소유인 폴더는 기억하지 않으므로, 처음 볼 때와 판정이 같다(not_owner).
- 폴더를 지우고 바꿔치면 파일 ID·생성 시각이 바뀌어 다시 읽는다. 바꿔치려면 부모 폴더의 삭제 권한도 필요하다.

## 잃는 것·남는 위험

- 프로세스가 사는 동안 관리자가 신뢰 소유 폴더의 소유자를 남에게 넘기면, 다음 기동까지 알아차리지 못한다. 관리자·SYSTEM 권한 공격자는 이 설계의 범위 밖이다(D05 §1, A-31).
- 첫 확인은 여전히 느리다(느린 PC에서 수 초). 금고 미리 확인(결정 4)이 첫 Chrome 기동 앞에서 그 시간을 숨긴다. 앱 기동 때 main의 루트 확인 1번은 남는다.
- 기억은 프로세스 메모리에만 있으므로 앱을 다시 켜면 다시 읽는다.

## 다음

- 금고 네이티브 헬퍼가 들어오면 `readOwner`를 `GetNamedSecurityInfoW(OWNER_SECURITY_INFORMATION)`로 바꾸고 PowerShell을 뺀다. 결정 1의 기억은 남겨도 해가 없다.
- 실기기에서 다시 잰다: 첫 Chrome 기동까지 걸린 시간, `vault.dir_check_warm.ms`, 두 번째 기동의 확인 시간.
