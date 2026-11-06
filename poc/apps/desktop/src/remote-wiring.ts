// 제품 진입점의 계정·기기·폰 연결 배선(팀장 결정 2026-11-06 (가)): 클라우드 포트(#145 cloudPorts, @sax/net Egress) + 금고 키(#146 vaultDesktopKeys).
// 운영은 https://tax.laf-co.com·wss://rooms.tax.laf-co.com만 연다. 개발 스택(localhost)은 설치본이 아닌 실행에서 SAX_CLOUD_DEV=localhost:<port>일 때만
// (Egress cloudDevLocal도 그때만 켠다). 주소는 main 환경에서만 읽는다(렌더러는 주소를 넘기지 못한다).
import { Egress, type EgressSecurityEvent } from '@sax/net';
import { cloudPorts } from './remote-cloud.ts';
import { vaultDesktopKeys } from './remote-keys.ts';
import type { RemoteWiring } from './shell-app.ts';

const DEV_HOST = /^(localhost|127\.0\.0\.1):[0-9]{1,5}$/;

export interface ProductRemoteOptions {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  onSecurityEvent?: (e: EgressSecurityEvent) => void;
}

/** 어느 클라우드에 붙는지(시험·진단용, 값에 비밀 없음). 개발 값이 틀리면 null(연결하지 않는다). */
export function cloudTarget(o: Pick<ProductRemoteOptions, 'isPackaged' | 'env'>): { env: 'prod' } | { env: 'dev'; host: string } | null {
  const v = o.env.SAX_CLOUD_DEV;
  if (v === undefined || v === '' || o.isPackaged) return { env: 'prod' };
  return DEV_HOST.test(v) ? { env: 'dev', host: v } : null;
}

export function productRemote(o: ProductRemoteOptions): RemoteWiring {
  const t = cloudTarget(o);
  if (!t) return { cloud: null, keys: vaultDesktopKeys };
  const dev = t.env === 'dev';
  const egress = new Egress({ cloudDevLocal: dev, onSecurityEvent: o.onSecurityEvent, env: o.env });
  const cloud = cloudPorts(dev ? { egress, env: 'dev', dev: { accountOrigin: `http://${t.host}`, relayHost: t.host } } : { egress, env: 'prod' });
  return { cloud, keys: vaultDesktopKeys };
}
