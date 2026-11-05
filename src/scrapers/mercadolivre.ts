import { detectUnits } from '../deals.ts';
import type { Offer } from '../types.ts';

/**
 * Mercado Livre pela API oficial.
 *
 * A busca comum (/sites/MLB/search) e os detalhes de anúncio (/items) são restritos para
 * apps novos (403), então usamos o catálogo: /products/search encontra os produtos e
 * /products/{id}/items traz TODAS as ofertas dos vendedores, das quais pegamos a mais barata.
 *
 * O token é do próprio app (grant_type=client_credentials): basta ML_CLIENT_ID e
 * ML_CLIENT_SECRET, sem precisar conectar uma conta de usuário.
 */

const API = 'https://api.mercadolibre.com';
/** Quantos produtos do catálogo consultar por busca (cada um custa 1 requisição). */
const MAX_PRODUCTS = 20;
/** Requisições simultâneas à API. */
const CONCURRENCY = 5;

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

/** Executa `fn` sobre a lista com no máximo `limit` chamadas em paralelo. */
async function mapLimit<T, R>(list: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]);
    }
  });
  await Promise.all(workers);
  return out;
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
  official_store_id?: number | null;
  shipping?: { free_shipping?: boolean; logistic_type?: string };
}

function badgesFor(item: CatalogItem): string[] {
  const badges: string[] = [];
  if (item.original_price && item.original_price > item.price) {
    badges.push(`-${Math.round((1 - item.price / item.original_price) * 100)}%`);
  }
  if (item.shipping?.free_shipping) badges.push('Frete grátis');
  if (item.shipping?.logistic_type === 'fulfillment') badges.push('Full');
  if (item.official_store_id) badges.push('Loja oficial');
  return badges;
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

  const offers = await mapLimit(search.body?.results ?? [], CONCURRENCY, async (p): Promise<Offer | undefined> => {
    // 404 "No winners found" = produto sem vendedor ativo no momento.
    const { status, body } = await get<{ results?: CatalogItem[] }>(`/products/${p.id}/items?limit=50`, token);
    if (status !== 200) return undefined;
    // As ofertas não vêm ordenadas por preço: procura a mais barata entre todas.
    const items = (body?.results ?? []).filter((i) => i.condition !== 'used' && i.price > 0);
    if (!items.length) return undefined;
    const cheapest = items.reduce((a, b) => (b.price < a.price ? b : a));
    return {
      store: 'Mercado Livre',
      title: p.name,
      price: cheapest.price,
      oldPrice: cheapest.original_price ?? undefined,
      // Página do produto no catálogo (lista todas as ofertas, inclusive a mais barata).
      url: `https://www.mercadolivre.com.br/p/${p.id}`,
      image: p.pictures?.[0]?.url?.replace(/^http:/, 'https:'),
      available: true,
      units: detectUnits(p.name),
      badges: badgesFor(cheapest),
    };
  });
  return offers.filter((o): o is Offer => o !== undefined);
}
