// 앱에 핀 고정하는 레지스트리 키(D09 §8.2: 앱 업데이트로만 바뀐다, ADR-028 결정 3 keyEpoch). 서명 의식(오프라인 루트·패키지·정책·긴급·
// 타임스탬프 키 생성) 전이라 아직 없다. 없으면 엔진은 레지스트리를 받지 않고 질의는 registry.not_pinned로 답한다(fail-closed).
// 시험은 tests/fixtures/registry/trust.json(공개 시험 시드)을 RegistrySync에 직접 넘긴다. 시험 키를 여기에 넣지 않는다.
import type { TrustPin } from './registry-sync.ts';

export const REGISTRY_TRUST_PIN: TrustPin | null = null;
