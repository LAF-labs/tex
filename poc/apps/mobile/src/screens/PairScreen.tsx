// S-03 폰 쪽(D08 §4): 앱 안 스캐너로 PC의 QR을 찍고 → 검사(만료·릴레이 허용 목록) → Noise XXpsk0 → 6자리를 보여 준다
// (사용자가 PC에 입력, "일치" 버튼 없음) → pair.ok 검사(AIK 서명 기기 목록·이 PC가 목록에 있음) → 24시간 경고
// → PC 이름·가린 계정 이메일 확인([내 계정 맞음], 설계 #120) → 저장.
// 폰에는 계정 로그인이 없어 서버에서 기기 목록을 받지 않는다. 계정 등록은 PC가 대신 한다(팀장 결정 2026-11-06, D08 §4.2 3·7단계).
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { MobilePairing, b64, fromB64, softNoiseStatic, type MobilePairFailure, type MobilePairResult } from '@sax/remote';
import { DEV_LOCAL, relayAllowlist } from '../config';
import { inflight } from '../inflight';
import { devFetchQr } from '../net/account';
import { identityLines, maskEmail } from '../pairing/identity';
import { relayFor } from '../net/pc';
import { useSession } from '../session';
import { space, usePalette } from '../theme';
import { Button, Card, Notice, Screen, T } from '../ui/kit';

type Phase = 'scan' | 'warn' | 'confirm' | 'working' | 'sas' | 'done' | 'failed';

const FAIL: Record<MobilePairFailure | 'relay' | 'save', string> = {
  qr_invalid: 'tex의 연결 QR이 아니에요. PC 화면의 QR을 다시 찍어 주세요.',
  qr_expired: 'QR 시간이 지났어요. PC에서 [새 QR]을 눌러 주세요.',
  relay_not_allowed: '알 수 없는 연결 서버예요. 연결을 멈췄어요.',
  devlist_invalid: '계정의 기기 목록 서명이 맞지 않아요. 연결을 멈췄어요.',
  desktop_unknown: '계정에 등록된 PC가 아니에요. 직접 설치한 PC가 아니면 연결하지 마세요.',
  handshake: 'PC와 연결하지 못했어요. PC에서 [새 QR]을 눌러 다시 해 주세요.',
  pair_ok_invalid: 'PC가 보낸 연결 정보가 맞지 않아요. 연결을 멈췄어요.',
  aik_mismatch: '계정 정보가 서로 달라요. 연결을 멈췄어요. 계정 메일을 확인해 주세요.',
  timeout: '시간이 지났어요. PC에서 다시 시작해 주세요.',
  relay: '연결 서버에 닿지 않아요. 인터넷 연결을 확인해 주세요.',
  save: '연결 정보를 이 폰에 저장하지 못했어요. PC에서 [새 QR]을 눌러 다시 연결해 주세요.',
};

export function PairScreen({ onDone }: { onDone: () => void }) {
  const s = useSession();
  const p = usePalette();
  const [perm, requestPerm] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scan');
  const [fail, setFail] = useState<keyof typeof FAIL | null>(null);
  const [sas, setSas] = useState<string | null>(null);
  const pairing = useRef<MobilePairing | null>(null);
  const noiseRef = useRef<ReturnType<typeof softNoiseStatic> | null>(null);
  const scanned = useRef(false);
  const linkRef = useRef<{ close(): void } | null>(null);
  /** 24시간 경고·계정 확인에서 사용자가 고르기 전까지 들고 있는 pair.ok 결과(아직 저장하지 않았다). */
  const pendingRef = useRef<MobilePairResult | null>(null);
  const gone = useRef(false);

  // 화면을 떠나면(잠금 포함) 페어링을 멈춘다: 룸 연결을 닫아 PC 쪽도 끝나게 하고(1회용 룸), 메모리의 Sm 사본을 지운다.
  // 잠긴 뒤 PC가 SAS를 받아도 폰은 키 없이 pair.ok를 저장할 수 없으므로, 끝까지 가지 않게 한다.
  useEffect(
    () => () => {
      gone.current = true;
      linkRef.current?.close();
      noiseRef.current?.destroy();
    },
    [],
  );

  const failWith = (f: keyof typeof FAIL) => {
    if (gone.current) return;
    setFail(f);
    setPhase('failed');
  };

  async function onQr(text: string) {
    if (scanned.current) return;
    scanned.current = true;
    noiseRef.current?.destroy();
    const noise = softNoiseStatic(s.keys.sm);
    noiseRef.current = noise;
    const mp = new MobilePairing({
      keys: {
        noise, vmPub: s.keys.vmPub, kmPub: s.keys.kmPub, deviceId: s.keys.deviceId,
        name: (Device.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android')).slice(0, 40),
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      },
      // 다시 연결이면 앞서 고정한 계정 AIK와 같아야 한다(C-01). 처음이면 QR·6자리로 고른 이 PC의 AIK를 믿는다(TOFU).
      knownAikPub: s.data.pair ? fromB64(s.data.pair.aikPub) : undefined,
      seenListVersion: s.data.seenListVersion,
      relayAllowlist: relayAllowlist(),
    });
    pairing.current = mp;
    mp.onState((st) => {
      if (st === 'show_sas') {
        setSas(mp.sas);
        setPhase('sas');
      }
    });
    if (!mp.scan(text)) return failWith(mp.failure ?? 'qr_invalid');
    await run(mp);
  }

  async function run(mp: MobilePairing) {
    setPhase('working');
    let link;
    try {
      link = await relayFor(mp.relayHost).joinRoom(mp.roomId, 'mobile');
    } catch {
      return failWith('relay');
    }
    linkRef.current = link;
    if (gone.current) return link.close();
    let r: Awaited<ReturnType<MobilePairing['run']>>;
    try {
      r = await mp.run(link);
    } catch {
      r = null;
    }
    if (!r) {
      // 룸 연결을 닫는다(룸은 1회용이라 릴레이가 폐기한다. 다시 할 때는 PC의 새 QR로 새 룸을 연다).
      link.close();
      return failWith(mp.failure ?? 'handshake');
    }
    r.channel.close();
    if (gone.current) return;
    // 3단계 24시간 경고는 PAIR_OK의 AIK 서명 목록으로 판단한다. 그 뒤 PC 이름·계정을 확인한다. 둘 다 고르기 전에는 저장하지 않는다.
    pendingRef.current = r;
    setPhase(mp.newDesktopWarning ? 'warn' : 'confirm');
  }

  const stop = () => {
    pendingRef.current = null;
    onDone();
  };

  async function save(r: MobilePairResult) {
    pendingRef.current = null;
    if (gone.current) return;
    try {
      await inflight(() => s.update((d) => ({
        ...d,
        pair: {
          pairId: r.pairId, desktopStatic: b64(r.desktopStatic), desktopVd: b64(r.desktopVd), desktopDeviceId: r.desktopDeviceId,
          desktopName: r.identity.desktopName, accountEmailMasked: r.identity.accountEmail ? maskEmail(r.identity.accountEmail) : null,
          kvPub: b64(r.kvPub), aikPub: b64(r.aikPub), cert: r.cert, certNotAfter: r.certNotAfter, mbxId: r.mbxId, tokRead: r.tokRead,
            tokWrite: r.tokWrite,
          mbxEpoch: r.mbxEpoch, relayHost: r.relayHost, pairedAt: Date.now(),
        },
        deviceList: r.deviceList,
        // 다시 연결하면 새 우편함·새 번들이다(seq가 처음부터). 옛 최고값을 두면 새 번들을 거부한다.
        qbundleSeq: 0,
        seenListVersion: Math.max(d.seenListVersion, r.deviceList.listVersion),
      })));
    } catch {
      // PC는 이미 이 폰을 받았지만 폰은 기록이 없다. 다시 연결하면 PC가 같은 키를 갱신한다(upsertDevice).
      // 화면 상태에는 남지 않도록 pair를 비워 둔다(저장 실패 뒤 메모리만 연결된 것처럼 보이지 않게).
      await s.update((d) => ({ ...d, pair: null })).catch(() => undefined);
      return failWith('save');
    }
    setPhase('done');
    void s.sync();
  }

  if (phase === 'scan') {
    return (
      <Screen>
        <View style={st.wrap}>
          <T v="title">PC의 QR을 찍어 주세요</T>
          <T c="ink2">PC의 tex 앱 → [폰 연결]에 뜬 QR을 네모 안에 맞춰요.</T>
          {perm?.granted ? (
            <View style={[st.scanner, { borderColor: p.lineStrong }]}>
              <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(e) => void onQr(e.data)} />
            </View>
          ) : (
            <Card>
              <T c="ink2">QR을 찍으려면 카메라가 필요해요. 사진은 저장하지 않아요.</T>
              <Button label="카메라 허용" onPress={() => void requestPerm()} />
            </Card>
          )}
          {DEV_LOCAL && <Button testID="dev-qr" kind="quiet" label="개발: 더미 PC의 QR 받기(시뮬레이터)" onPress={async () => void onQr(await devFetchQr())} />}
          <Button kind="secondary" label="취소" onPress={onDone} />
        </View>
      </Screen>
    );
  }

  if (phase === 'warn') {
    return (
      <Screen>
        <View style={st.wrap}>
          <Notice>이 PC는 오늘 등록되었습니다. 직접 등록한 PC가 아니면 중단하세요.</Notice>
          <T c="ink2">중단하면 이 폰에 연결 정보를 저장하지 않아요. 계정에 다른 기기가 있으면 그 기기와 메일로도 알려요.</T>
          <Button testID="warn-stop" kind="secondary" label="중단" onPress={stop} />
          <Button testID="warn-continue" kind="quiet" label="내가 등록한 PC예요. 계속" onPress={() => setPhase('confirm')} />
        </View>
      </Screen>
    );
  }

  if (phase === 'confirm' && pendingRef.current) {
    const id = pendingRef.current.identity;
    const lines = identityLines({ desktopName: id.desktopName, accountEmailMasked: id.accountEmail ? maskEmail(id.accountEmail) : null });
    return (
      <Screen>
        <View style={st.wrap} testID="pair-confirm">
          <T v="title">내 PC와 내 계정이 맞나요?</T>
          <Card>
            <T v="label" c="ink3">
              PC
            </T>
            <T testID="confirm-pc">{lines.pc}</T>
            <T v="label" c="ink3">
              계정
            </T>
            <T testID="confirm-account">{lines.account}</T>
          </Card>
          <T c="ink2">내 계정이 아니면 중단하세요. 중단하면 이 폰에 연결 정보를 저장하지 않아요. 연결한 뒤에도 PC 연결 화면에서 늘 볼 수 있어요.</T>
          <Button testID="confirm-mine" label="내 계정 맞음" onPress={() => pendingRef.current && void save(pendingRef.current)} />
          <Button testID="confirm-stop" kind="secondary" label="아니에요, 중단" onPress={stop} />
        </View>
      </Screen>
    );
  }

  if (phase === 'sas' && sas) {
    return (
      <Screen>
        <View style={st.wrap} testID="pair-sas">
          <T v="title">PC 화면에 이 숫자를 입력하세요</T>
          <View style={[st.sasBox, { backgroundColor: p.surface, borderColor: p.line }]}>
            <T v="sas" testID="sas-code">
              {sas}
            </T>
          </View>
          <Notice>이 숫자는 PC 화면에만 입력하세요. 전화·문자·메신저로 묻는 사람에게는 알려 주지 마세요.</Notice>
          <T v="caption" c="ink3">
            PC에서 입력하면 이 화면이 저절로 넘어가요. 세 번 틀리면 처음부터 다시 해요.
          </T>
        </View>
      </Screen>
    );
  }

  if (phase === 'done') {
    return (
      <Screen>
        <View style={st.wrap} testID="pair-done">
          <T v="title">PC와 연결됐어요</T>
          <T c="ink2">이제 영수증과 현금 매출을 이 PC로 보낼 수 있어요. 보낸 내용은 연결 서버가 볼 수 없어요.</T>
          <Button label="확인" onPress={onDone} />
        </View>
      </Screen>
    );
  }

  if (phase === 'failed') {
    return (
      <Screen>
        <View style={st.wrap}>
          <T v="title">연결하지 못했어요</T>
          <Notice>{FAIL[fail ?? 'handshake']}</Notice>
          <Button
            label="다시 찍기"
            onPress={() => {
              scanned.current = false;
              setFail(null);
              setPhase('scan');
            }}
          />
          <Button kind="secondary" label="닫기" onPress={onDone} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={st.wrap}>
        <T v="title">PC와 연결하는 중</T>
        <Button label="" busy onPress={() => {}} kind="quiet" />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, padding: space.s5, gap: space.s4 },
  scanner: { aspectRatio: 1, borderRadius: 12, overflow: 'hidden', borderWidth: 1 },
  sasBox: { alignItems: 'center', paddingVertical: space.s6, borderRadius: 12, borderWidth: 1 },
});
