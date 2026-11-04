import * as cheerio from 'cheerio';
import type { Offer } from '../types.ts';
import { fetchHtml, parsePrice } from './http.ts';

/**
 * Lê o preço de uma página de produto de qualquer loja usando dados estruturados
 * (JSON-LD schema.org/Product, ou meta tags og:/product:price). Funciona com a
 * maioria das lojas que não bloqueiam acesso automatizado.
 */
export async function scrapeProductPage(url: string): Promise<Offer[]> {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const store = new URL(url).hostname.replace(/^www\./, '');

  // 1) JSON-LD
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let json: unknown;
    try {
      json = JSON.parse($(el).text());
    } catch {
      continue;
    }
    for (const node of flattenLd(json)) {
      if (!isType(node, 'Product')) continue;
      const offers = ([] as any[]).concat(node.offers ?? []);
      const prices = offers
        .flatMap((o) => [o.price, o.lowPrice, o.priceSpecification?.price])
        .map(parsePrice)
        .filter((p): p is number => p !== undefined);
      if (!prices.length) continue;
      const availability = String(offers[0]?.availability ?? '');
      return [
        {
          store,
          title: String(node.name ?? $('title').text()).trim(),
          price: Math.min(...prices),
          url,
          image: Array.isArray(node.image) ? node.image[0] : node.image?.url ?? node.image,
          available: !/OutOfStock|SoldOut|Discontinued/i.test(availability),
        },
      ];
    }
  }

  // 2) Meta tags
  const meta = (name: string) =>
    $(`meta[property="${name}"]`).attr('content') ?? $(`meta[name="${name}"]`).attr('content');
  const price = parsePrice(meta('product:price:amount') ?? meta('og:price:amount'));
  if (price) {
    return [
      {
        store,
        title: (meta('og:title') ?? $('title').text()).trim(),
        price,
        url,
        image: meta('og:image'),
        available: !/out ?of ?stock/i.test(meta('product:availability') ?? ''),
      },
    ];
  }

  throw new Error('não encontrei o preço nos dados estruturados da página');
}

function flattenLd(json: unknown): any[] {
  if (Array.isArray(json)) return json.flatMap(flattenLd);
  if (json && typeof json === 'object') {
    const obj = json as any;
    return [obj, ...(obj['@graph'] ? flattenLd(obj['@graph']) : [])];
  }
  return [];
}

function isType(node: any, type: string): boolean {
  const t = node?.['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}
