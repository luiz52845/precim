import { mutate } from '../db.ts';
import type { DbShape, MlTokens, Offer } from '../types.ts';

/**
 * Mercado Livre pela API oficial (OAuth 2.0).
 * Docs: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
 */

const AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const API = 'https://api.mercadolibre.com';

export const mlConfigured = () => Boolean(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET);

/** URI de redirecionamento: ML_REDIRECT_URI ou https://<host>/api/ml/callback. */
export function mlRedirectUri(host?: string, proto = 'https'): string {
  return process.env.ML_REDIRECT_URI || `${proto}://${host ?? 'localhost:3000'}/api/ml/callback`;
}

export function mlAuthorizeUrl(redirectUri: string, state: string): string {
  return (
    AUTH_URL +
    '?' +
    new URLSearchParams({ response_type: 'code', client_id: process.env.ML_CLIENT_ID!, redirect_uri: redirectUri, state })
  );
}

async function tokenRequest(params: Record<string, string>): Promise<MlTokens> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      ...params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !body.access_token) {
    throw new Error(`Mercado Livre: ${body.message || body.error || `HTTP ${res.status}`}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 21600) * 1000,
    userId: body.user_id,
  };
}

export const mlExchangeCode = (code: string, redirectUri: string) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });

/** Devolve um access token válido, renovando (e gravando) se estiver perto de expirar. */
export async function mlAccessToken(db: DbShape): Promise<string> {
  if (!mlConfigured()) throw new Error('defina ML_CLIENT_ID e ML_CLIENT_SECRET nas variáveis de ambiente');
  if (!db.ml) throw new Error('conecte sua conta do Mercado Livre em Configurações');
  if (db.ml.expiresAt - Date.now() > 5 * 60_000) return db.ml.accessToken;

  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: db.ml.refreshToken });
  db.ml = fresh;
  await mutate((d) => {
    d.ml = fresh;
  });
  return fresh.accessToken;
}

interface MlItem {
  id: string;
  title: string;
  price: number;
  original_price: number | null;
  permalink: string;
  thumbnail?: string;
  condition?: string;
  available_quantity?: number;
}

export async function searchMercadoLivre(query: string, db: DbShape): Promise<Offer[]> {
  const token = await mlAccessToken(db);
  const res = await fetch(`${API}/sites/MLB/search?` + new URLSearchParams({ q: query, limit: '50' }), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 403) {
    throw new Error('a API de busca do Mercado Livre recusou o acesso (403); o endpoint pode estar restrito para o seu app');
  }
  const body = (await res.json().catch(() => ({}))) as { results?: MlItem[]; message?: string };
  if (!res.ok) throw new Error(`Mercado Livre: ${body.message ?? `HTTP ${res.status}`}`);

  return (body.results ?? [])
    .filter((i) => i.condition !== 'used')
    .map((i) => ({
      store: 'Mercado Livre',
      title: i.title,
      price: i.price,
      oldPrice: i.original_price ?? undefined,
      url: i.permalink,
      image: i.thumbnail?.replace(/^http:/, 'https:'),
      available: (i.available_quantity ?? 1) > 0,
    }));
}
