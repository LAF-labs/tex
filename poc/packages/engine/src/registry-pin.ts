// 앱에 핀 고정하는 레지스트리 키(D09 §8.2: 앱 업데이트로만 바뀐다, ADR-028 결정 3 keyEpoch).
// keyEpoch 1: 서명 의식 2026-11-06, 단독 모드(ADR-037). 정본은 services/registry/ceremony/keyepoch-1/trust-root.json
// (SHA-256 de24c32c46e46ab81020d0a2aa684cba99ed4fed48a6c2d02d5c72fa08e793e7), 루트 2-of-3 서명은 root-metadata.signed.json.
// 2026-11-06 타임스탬프 시드 교체로 keys.timestamp만 바꿔 루트 2개로 다시 서명했다(앞 판은 공개하지 않는다).
// 오프라인 키(root·package·policy·emergency·release)는 macOS Secure Enclave 감싸기, timestamp-1은 레지스트리 서버 온라인 키다.
// 시험은 tests/fixtures/registry/trust.json(공개 시험 시드)을 RegistrySync에 직접 넘긴다. 시험 키를 여기에 넣지 않는다.
import type { TrustPin } from './registry-sync.ts';

export const REGISTRY_TRUST_PIN: TrustPin | null = {
  keyEpoch: 1,
  keys: {
    root: {
      'root-1': 'uybpi640dHXw0f8mCe/g9Ej1ZKgmXtC+hezBf084NBg=',
      'root-2': 'N5gawj6akHawn/AsIF698DpmQPrOwIgZ+2dWRG8SzBI=',
      'root-3': 'Oyzmx1CCMbDgBkmMtA/xUaYmtb6d8mMBgYwrSWiw4cc=',
    },
    package: {
      'package-1': 'OGw4mQc2I4ZDKRYjQfGfvH9YTcw9+NdVEpeLXfsxRik=',
      'package-2': 'AwV3cSZHYgCiLKD3edkacjQrgvoEtTJ7v7cQzgIENws=',
      'package-3': 'baNYHUP7VEEvFDZF9QRv3/UVyipItqjWT+rsUwomyy8=',
    },
    policy: {
      'policy-1': 'Auoy1stbA0UFtrZUpnytK2KCYvTTRCSQDirrwGr4yGQ=',
      'policy-2': 'dF90/DrgXXmBZ7/ldgNEyddWdEgpJjq6KT0IfLHYsAI=',
      'policy-3': 'EvkupMcIA9JGpjddNNhtbgScqA/J7u2EkTTTKVrsy1c=',
    },
    emergency: {
      'emergency-1': 'h0wUMJvNWJGy7Hg+QGxKkNPFaSuPv+mBJSebxJXukOc=',
    },
    timestamp: {
      'timestamp-1': 'KU0/rmJmf1mrL+6VSZbNyxfW+kdob9LRvQJDHttVYVg=',
    },
    release: {
      'release-1': 'DQG3gnFx0VJ6J/TXOxKZ5LMR0D6Wng5mMZmUDxldXwE=',
    },
  },
};
