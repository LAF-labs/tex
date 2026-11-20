import net from 'node:net';
import type { ConnectionOptions } from 'node:tls';

/**
 * Supabase Root 2021 CA(자체 서명, 만료 2031-04-26). SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA.
 * 공식 배포본(prod-ca-2021.crt)·풀러가 보내는 루트와 같다(2026-11-06 확인). 풀러 체인: *.pooler.supabase.com ← Supabase Intermediate 2021 CA ← 이 루트.
 */
export const SUPABASE_ROOT_2021_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

const SSL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation', 'sslcrl', 'sslpassword'];
const VERIFY = new Set(['require', 'verify-ca', 'verify-full']);

const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '' || host.startsWith('%2F');

export interface PgConnectConfig {
  connectionString: string;
  ssl: false | ConnectionOptions;
}

/**
 * DATABASE_URL → node-pg 설정. 오류 메시지는 이름만(URL·비밀번호를 담지 않는다).
 * anchors는 시험용 주입이다. 운영 코드는 기본값(Supabase Root 2021 CA)만 쓴다.
 */
export function pgConnectConfig(url: string, anchors: readonly string[] = [SUPABASE_ROOT_2021_CA]): PgConnectConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('config_DATABASE_URL');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('config_DATABASE_URL');
  const mode = u.searchParams.get('sslmode');
  for (const k of SSL_PARAMS) if (k !== 'sslmode' && u.searchParams.has(k)) throw new Error('config_DATABASE_URL_ssl_param');
  u.searchParams.delete('sslmode');
  const host = u.hostname;
  const connectionString = u.toString();
  if (isLocal(host) && (mode === null || mode === 'disable')) return { connectionString, ssl: false };
  if (mode === null || !VERIFY.has(mode)) throw new Error('config_DATABASE_URL_sslmode');
  if (anchors.length === 0) throw new Error('config_DATABASE_CA');
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  return {
    connectionString,
    ssl: { ca: [...anchors], rejectUnauthorized: true, ...(net.isIP(bare) ? {} : { servername: bare }) },
  };
}
