import { Egress, type EgressSecurityEvent } from '@sax/net';
import { cloudPorts } from './remote-cloud.ts';
import { vaultDesktopKeys } from './remote-keys.ts';
import type { RemoteWiring } from './shell-app.ts';

export const PROD_PHONE_PAIRING = true;

const DEV_HOST = /^(localhost|127\.0\.0\.1):[0-9]{1,5}$/;

interface ProductRemoteOptions {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  onSecurityEvent?: (e: EgressSecurityEvent) => void;
}

export function cloudTarget(o: Pick<ProductRemoteOptions, 'isPackaged' | 'env'>): { env: 'prod' } | { env: 'dev'; host: string } | null {
  const v = o.env.SAX_CLOUD_DEV;
  if (v === undefined || v === '' || o.isPackaged) return { env: 'prod' };
  return DEV_HOST.test(v) ? { env: 'dev', host: v } : null;
}

export function productRemote(o: ProductRemoteOptions): RemoteWiring {
  const t = cloudTarget(o);
  if (!t) return { cloud: null, keys: vaultDesktopKeys, pairing: false };
  const dev = t.env === 'dev';
  const egress = new Egress({ cloudDevLocal: dev, onSecurityEvent: o.onSecurityEvent, env: o.env });
  const cloud = cloudPorts(dev ? { egress, env: 'dev', dev: { accountOrigin: `http://${t.host}`, relayHost: t.host } } : { egress, env: 'prod' });
  return { cloud, keys: vaultDesktopKeys, pairing: dev || PROD_PHONE_PAIRING };
}
