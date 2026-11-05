// P-08 종이 증빙 촬영: 앱 안 카메라 → 안내 틀로 자르기 → 기기 안 OCR → 규칙 파서 후보 → 사장님 확인 → 보관함 → PC로.
// 갤러리 가져오기 없음, 카메라 롤 저장 없음(ADR-034 결정 9). 카메라·편집 임시 파일은 캐시에 생기며 봉인해 옮긴 뒤 바로 지운다.
// 사진·금액은 로그에 넣지 않는다.
import { Asset } from 'expo-asset';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View, type LayoutRectangle } from 'react-native';
import { makeReceiptOffer, type ReceiptCandidates } from '@sax/remote';
import { DEV_LOCAL, PHOTO_MAX_EDGE, PHOTO_QUALITY } from '../config';
import { fitEdge, guideCrop, guideRect } from '../capture/crop';
import { ocrEngine } from '../capture/ocr';
import { parseReceipt, validBizNo } from '../capture/parser';
import { useSession } from '../session';
import { deleteQuietly } from '../storage/files';
import { radius, space, type, usePalette } from '../theme';
import { Button, Card, Notice, Screen, T } from '../ui/kit';
import sampleReceipt from '../../assets/dev/sample-receipt.jpg';

interface Shot {
  uri: string;
  width: number;
  height: number;
  capturedAt: number;
}

type Phase = 'camera' | 'reading' | 'confirm' | 'saving' | 'saved';

export function CaptureScreen({ onDone }: { onDone: () => void }) {
  const s = useSession();
  const p = usePalette();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [view, setView] = useState<LayoutRectangle | null>(null);
  const [phase, setPhase] = useState<Phase>('camera');
  const [shot, setShot] = useState<Shot | null>(null);
  const [engine, setEngine] = useState<'ios_vision' | 'none'>('none');
  const [f, setF] = useState({ amount: '', issuedOn: '', merchant: '', bizNo: '' });
  const [err, setErr] = useState<string | null>(null);
  const temp = useRef<string[]>([]);

  const cleanup = () => {
    for (const u of temp.current) deleteQuietly(u);
    temp.current = [];
  };

  async function process(raw: { uri: string; width: number; height: number }, crop: boolean) {
    setPhase('reading');
    temp.current.push(raw.uri);
    try {
      let ctx = ImageManipulator.manipulate(raw.uri);
      let w = raw.width;
      let h = raw.height;
      if (crop && view) {
        const c = guideCrop(raw, view, guideRect(view));
        ctx = ctx.crop(c);
        w = c.width;
        h = c.height;
      }
      const fit = fitEdge(w, h, PHOTO_MAX_EDGE);
      if (fit) ctx = ctx.resize(fit);
      const img = await ctx.renderAsync();
      const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_QUALITY });
      temp.current.push(out.uri);
      const ocr = ocrEngine();
      const lines = await ocr.read(out.uri);
      const c = parseReceipt(lines);
      setEngine(ocr.id);
      setF({ amount: c.amount ? String(c.amount) : '', issuedOn: c.issuedOn ?? '', merchant: c.merchant ?? '', bizNo: c.merchantBizNo ?? '' });
      setShot({ uri: out.uri, width: out.width, height: out.height, capturedAt: Date.now() });
      setPhase('confirm');
    } catch {
      cleanup();
      setErr('사진을 처리하지 못했어요. 다시 찍어 주세요.');
      setPhase('camera');
    }
  }

  async function take() {
    setErr(null);
    try {
      const r = await cam.current?.takePictureAsync({ quality: 0.92, exif: false, shutterSound: true });
      if (r) await process(r, true);
    } catch {
      setErr('사진을 찍지 못했어요.');
    }
  }

  /** 시뮬레이터 개발 빌드만: 카메라가 없어서 앱에 묶인 견본 영수증을 카메라 프레임 대신 쓴다(갤러리 아님). */
  async function devSample() {
    const a = Asset.fromModule(sampleReceipt);
    await a.downloadAsync();
    const src = new File(a.localUri!);
    const copy = new File(src.parentDirectory, `dev-shot-${Date.now()}.jpg`);
    src.copySync(copy);
    await process({ uri: copy.uri, width: a.width ?? 1200, height: a.height ?? 1800 }, false);
  }

  function candidates(): ReceiptCandidates | string {
    const c: ReceiptCandidates = {};
    const amt = f.amount.replace(/[,\s원]/g, '');
    if (amt) {
      const n = Number(amt);
      if (!Number.isSafeInteger(n) || n <= 0 || n > 100_000_000_000) return '금액을 숫자로 적어 주세요.';
      c.amount = n;
    }
    if (f.issuedOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.issuedOn) || Number.isNaN(Date.parse(`${f.issuedOn}T00:00:00Z`))) return '날짜는 2026-11-05처럼 적어 주세요.';
      c.issuedOn = f.issuedOn;
    }
    if (f.merchant.trim()) c.merchant = f.merchant.trim().slice(0, 80);
    if (f.bizNo) {
      const d = f.bizNo.replace(/\D/g, '');
      if (!validBizNo(d)) return '사업자번호가 맞지 않아요. 비워 두어도 돼요.';
      c.merchantBizNo = `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
    }
    return c;
  }

  async function save() {
    if (!shot) return;
    const c = candidates();
    if (typeof c === 'string') return setErr(c);
    setPhase('saving');
    try {
      const jpeg = await new File(shot.uri).bytes();
      const offer = makeReceiptOffer(jpeg, { capturedAt: shot.capturedAt, width: shot.width, height: shot.height, ocrEngine: engine, ownerConfirmed: true, candidates: c });
      await s.outbox.put({ kind: 'receipt', msgId: offer.msgId, offer, createdAt: Date.now(), attempts: 0 }, jpeg);
      jpeg.fill(0);
      cleanup();
      setShot(null);
      await s.refreshPending();
      setPhase('saved');
      void s.sync();
    } catch {
      setErr('사진을 보관하지 못했어요. 이 폰에 보호된 저장 공간이 없으면 보낼 수 없어요.');
      setPhase('confirm');
    }
  }

  const close = () => {
    cleanup();
    onDone();
  };

  if (phase === 'saved') {
    return (
      <Screen>
        <View style={st.pad} testID="capture-saved">
          <T v="title">{s.pc === 'online' ? 'PC로 보내는 중이에요' : '폰에 두었다가 PC가 켜지면 보내요'}</T>
          <T c="ink2">사진은 이 폰의 보호된 공간에만 있고, 사진 앱에는 저장하지 않았어요. PC가 받으면 폰에서 지워요.</T>
          <Button label="한 장 더 찍기" onPress={() => setPhase('camera')} />
          <Button kind="secondary" label="처음으로" onPress={close} />
        </View>
      </Screen>
    );
  }

  if ((phase === 'confirm' || phase === 'saving') && shot) {
    const field = (label: string, key: keyof typeof f, props: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
      <View style={{ gap: space.s1 }}>
        <T v="label" c="ink2">
          {label}
        </T>
        <TextInput
          testID={`field-${key}`}
          value={f[key]}
          onChangeText={(t) => setF({ ...f, [key]: t })}
          style={[type.body, st.input, { color: p.ink, borderColor: p.lineStrong, backgroundColor: p.surface }]}
          placeholderTextColor={p.ink4}
          {...props}
        />
      </View>
    );
    return (
      <Screen>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={st.pad} testID="capture-confirm">
            <T v="title">읽은 내용을 확인해 주세요</T>
            <Image source={{ uri: shot.uri }} style={[st.preview, { borderColor: p.line }]} resizeMode="contain" />
            <Card>
              {engine === 'none' && <T v="caption" c="ink3">이 폰에서는 글자를 읽지 않아요. 비워 두면 PC가 사진에서 읽어요.</T>}
              {field('금액(원)', 'amount', { keyboardType: 'number-pad', placeholder: '15000' })}
              {field('날짜', 'issuedOn', { placeholder: '2026-11-05' })}
              {field('상호', 'merchant', { placeholder: '가게 이름' })}
              {field('사업자번호', 'bizNo', { keyboardType: 'number-pad', placeholder: '000-00-00000' })}
              <T v="caption" c="ink3">
                폰이 읽은 값은 참고용이에요. PC가 사진을 다시 읽어 세무사 꾸러미에 넣어요.
              </T>
            </Card>
            {err && <Notice>{err}</Notice>}
            <Button testID="capture-send" label="PC로 보내기" onPress={save} busy={phase === 'saving'} />
            <Button
              kind="secondary"
              label="다시 찍기"
              onPress={() => {
                cleanup();
                setShot(null);
                setPhase('camera');
              }}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </Screen>
    );
  }

  const g = view ? guideRect(view) : null;
  return (
    <Screen style={{ backgroundColor: '#000' }}>
      <View style={{ flex: 1 }} onLayout={(e) => setView(e.nativeEvent.layout)} testID="capture-camera">
        {perm?.granted && !DEV_LOCAL ? (
          <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" animateShutter />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1F2328' }]} />
        )}
        {g && <View pointerEvents="none" style={[st.guide, { left: g.x, top: g.y, width: g.w, height: g.h }]} />}
        <View style={st.topHint}>
          <T v="label" c="onAccent">
            영수증을 틀 안에 맞춰 주세요
          </T>
        </View>
        {phase === 'reading' && (
          <View style={st.topHint}>
            <T v="label" c="onAccent">
              글자를 읽는 중…
            </T>
          </View>
        )}
      </View>
      <View style={st.bar}>
        {err && <Notice>{err}</Notice>}
        {!perm?.granted && !DEV_LOCAL ? (
          <Button label="카메라 허용" onPress={() => void requestPerm()} />
        ) : DEV_LOCAL ? (
          <Button testID="dev-sample" label="개발: 견본 영수증으로 찍기(시뮬레이터)" onPress={() => void devSample()} busy={phase === 'reading'} />
        ) : (
          <Button testID="shutter" label="찍기" onPress={() => void take()} busy={phase === 'reading'} />
        )}
        <Button kind="secondary" label="닫기" onPress={close} />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  pad: { padding: space.s5, gap: space.s4 },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.s3, paddingVertical: space.s2, minHeight: 44 },
  preview: { width: '100%', height: 260, borderRadius: radius.lg, borderWidth: 1 },
  guide: { position: 'absolute', borderColor: '#FFFFFF', borderWidth: 2, borderRadius: radius.md },
  topHint: { position: 'absolute', top: space.s4, alignSelf: 'center', backgroundColor: '#00000099', borderRadius: 9999, paddingHorizontal: space.s4, paddingVertical: space.s2 },
  bar: { padding: space.s4, gap: space.s2, backgroundColor: '#000' },
});
