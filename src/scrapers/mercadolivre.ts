import type { Offer } from '../types.ts';

/**
 * Mercado Livre pela API oficial.
 *
 * A busca comum (/sites/MLB/search) é restrita para apps novos (403), então usamos o
 * catálogo: /products/search encontra os produtos e /products/{id}/items traz as ofertas
 * dos vendedores com preço.
 *
 * O token é do próprio app (grant_type=client_credentials): basta ML_CLIENT_ID e
 * ML_CLIENT_SECRET, sem precisar conectar uma conta de usuário.
 */

const API = 'https://api.mercadolibre.com';
/** Quantos produtos do catálogo consultar por busca (cada um custa 1 requisição). */
const MAX_PRODUCTS = 10;

export const mlConfigured = () => Boolean(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET);

let cached: { token: string; expiresAt: number } | undefined;

async function appToken(): Promise<string> {
  if (!mlConfigured()) throw new Error('defina ML_CLIENT_ID e ML_CLIENT_SECRET nas variáveis de ambiente');
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !body.access_token) {
    throw new Error(`Mercado Livre (token): ${body.message || body.error || `HTTP ${res.status}`}`);
  }
  cached = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 21600) * 1000 };
  return cached.token;
}

async function get<T>(path: string, token: string): Promise<{ status: number; body: T | undefined }> {
  const res = await fetch(API + path, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T | undefined };
}

interface CatalogProduct {
  id: string;
  name: string;
  pictures?: { url?: string }[];
}

interface CatalogItem {
  item_id: string;
  price: number;
  original_price: number | null;
  condition?: string;
}

export async function searchMercadoLivre(query: string): Promise<Offer[]> {
  const token = await appToken();
  const search = await get<{ results?: CatalogProduct[]; message?: string }>(
    '/products/search?' + new URLSearchParams({ status: 'active', site_id: 'MLB', q: query, limit: String(MAX_PRODUCTS) }),
    token,
  );
  if (search.status !== 200) {
    throw new Error(`Mercado Livre (busca no catálogo): ${search.body?.message ?? `HTTP ${search.status}`}`);
  }

  const products = search.body?.results ?? [];
  const offers = await Promise.all(
    products.map(async (p): Promise<Offer | undefined> => {
      // 404 "No winners found" = produto sem vendedor ativo no momento.
      const { status, body } = await get<{ results?: CatalogItem[] }>(`/products/${p.id}/items?limit=5`, token);
      if (status !== 200) return undefined;
      const items = (body?.results ?? []).filter((i) => i.condition !== 'used' && i.price > 0);
      if (!items.length) return undefined;
      const cheapest = items.reduce((a, b) => (b.price < a.price ? b : a));
      return {
        store: 'Mercado Livre',
        title: p.name,
        price: cheapest.price,
        oldPrice: cheapest.original_price ?? undefined,
        // Página do produto no catálogo (mostra todas as ofertas).
        url: `https://www.mercadolivre.com.br/p/${p.id}`,
        image: p.pictures?.[0]?.url?.replace(/^http:/, 'https:'),
        available: true,
      };
    }),
  );
  return offers.filter((o): o is Offer => o !== undefined);
}
