// 업데이트 원천(UpdateSources)의 제품 구현: 레지스트리는 egress 한 입구로만 읽는다. 신뢰 판단은 @sax/updater가 한다.
import type { Egress } from '@sax/net';
import { checkReleaseLogged, type Channel, type LoggedRelease, type LogReader, type Revocation, type TrustRoot } from '@sax/updater';
import type { UpdateSources } from './update-host.ts';

export function egressUpdateSources(o: { egress: Pick<Egress, 'getRegistry' | 'getRegistryBytes'>; trust: TrustRoot; revocation: () => Promise<Revocation> }): UpdateSources {
  const reader: LogReader = {
    async get(target) {
      try {
        const r = await o.egress.getRegistry(target);
        return r.status === 200 ? r.json : null;
      } catch {
        return null;
      }
    },
  };
  // 로그 항목은 불변이라 한 번 확인한 릴리스 위치는 기동 동안 다시 찾지 않는다
  const cache = new Map<string, LoggedRelease>();
  return {
    async latest(channel: Channel) {
      const r = await o.egress.getRegistryBytes(`/releases/${channel}/latest.json`);
      if (r.status !== 200 || !r.body) throw new Error(`update.latest_status_${r.status}`);
      return r.body;
    },
    async registry() {
      return { trust: o.trust, revocation: await o.revocation() };
    },
    transparency(bytes: Uint8Array, channel: Channel) {
      return checkReleaseLogged({ reader, trust: o.trust, channel, bytes, cache });
    },
  };
}
