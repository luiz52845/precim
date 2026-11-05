import * as cheerio from 'cheerio';
import type { Offer } from '../types.ts';
import { BlockedError, fetchHtml, parsePrice } from './http.ts';

const BASE = 'https://www.amazon.com.br';

export async function searchAmazon(query: string): Promise<Offer[]> {
  const html = await fetchHtml(`${BASE}/s?k=${encodeURIComponent(query)}`);
  const $ = cheerio.load(html);

  if ($('form[action*="validateCaptcha"]').length) {
    throw new BlockedError('a Amazon pediu verificação (captcha); tente de novo mais tarde');
  }

  const offers: Offer[] = [];
  $('div[data-component-type="s-search-result"]').each((_, el) => {
    const item = $(el);
    const title = (item.find('h2').attr('aria-label') || item.find('h2').text())
      .replace(/^\s*an[uú]ncio patrocinado\s*[–—-]\s*/i, '') // remove o rótulo de anúncio
      .trim();
    const price = parsePrice(item.find('.a-price:not(.a-text-price) .a-offscreen').first().text());
    const asin = item.attr('data-asin');
    if (!title || !price || !asin) return;

    offers.push({
      store: 'Amazon',
      title,
      price,
      oldPrice: parsePrice(item.find('.a-price.a-text-price .a-offscreen').first().text()),
      // Link canônico curto (sem parâmetros de rastreamento).
      url: `${BASE}/dp/${asin}`,
      image: item.find('img.s-image').attr('src'),
      available: true,
    });
  });
  return offers;
}
