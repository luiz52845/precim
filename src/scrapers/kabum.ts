import * as cheerio from 'cheerio';
import type { Offer } from '../types.ts';
import { fetchHtml } from './http.ts';

const BASE = 'https://www.kabum.com.br';

interface KabumProduct {
  code: number;
  name: string;
  friendlyName: string;
  price: number;
  priceWithDiscount: number;
  oldPrice: number;
  available: boolean;
  image?: string;
  offer?: { priceWithDiscount?: number } | null;
}

/** A Kabum (Next.js) embute os resultados em JSON no <script id="__NEXT_DATA__">. */
export async function searchKabum(query: string): Promise<Offer[]> {
  const slug = encodeURIComponent(query.trim().toLowerCase().replace(/\s+/g, '-'));
  const html = await fetchHtml(`${BASE}/busca/${slug}`);
  const raw = cheerio.load(html)('script#__NEXT_DATA__').text();
  if (!raw) throw new Error('formato da página da Kabum mudou (sem __NEXT_DATA__)');

  const next = JSON.parse(raw);
  let data = next?.props?.pageProps?.data;
  if (typeof data === 'string') data = JSON.parse(data);
  const products: KabumProduct[] = data?.catalogServer?.data ?? [];

  return products
    .map((p): Offer => {
      // Preço à vista (PIX) é o menor; usa o da oferta relâmpago quando houver.
      const price = p.offer?.priceWithDiscount || p.priceWithDiscount || p.price;
      return {
        store: 'Kabum',
        title: p.name,
        price,
        oldPrice: p.oldPrice || (p.price > price ? p.price : undefined),
        url: `${BASE}/produto/${p.code}/${p.friendlyName}`,
        image: p.image,
        available: p.available,
      };
    })
    .filter((o) => o.price > 0);
}
