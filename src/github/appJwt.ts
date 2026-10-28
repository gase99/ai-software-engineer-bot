import { base64Decode, base64UrlEncode, utf8 } from '../util/crypto.js';

/**
 * GitHub App authentication without any dependency: an RS256 JWT signed with
 * WebCrypto (identical code path on Workers and Node), exchanged for a short
 * lived installation token (max 1 hour).
 */

export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  return base64Decode(body);
}

export async function signAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const keyData = pemToPkcs8(privateKeyPem);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - 60, // tolerate small clock skew
    exp: nowSeconds + 9 * 60, // GitHub caps App JWTs at 10 minutes
    iss: appId,
  };
  const encodedHeader = base64UrlEncode(utf8(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(utf8(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repositories?: Array<{ name: string; full_name: string }>;
}

export async function createInstallationToken(input: {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}): Promise<InstallationTokenResponse> {
  const jwt = await signAppJwt(input.appId, input.privateKeyPem, input.nowSeconds);
  const doFetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await doFetch(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ai-software-engineer-bot',
    },
  });
  const body = (await response.json().catch(() => ({}))) as InstallationTokenResponse & { message?: string };
  if (!response.ok) throw new Error(`github app token failed (${response.status}): ${body.message ?? 'unknown'}`);
  return body;
}
