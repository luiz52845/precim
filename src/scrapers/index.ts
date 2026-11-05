import { detectUnits } from '../deals.ts';
import type { DbShape, Offer, ScrapeResult, StoreId, Watch } from '../types.ts';
import { searchAmazon } from './amazon.ts';
import { searchKabum } from './kabum.ts';
import { searchMercadoLivre } from './mercadolivre.ts';
import { scrapeProductPage } from './product-page.ts';
import { sleep } from './http.ts';

export const STORES: Record<StoreId, { label: string; search: (q: string, db: DbShape) => Promise<Offer[]> }> = {
  amazon: { label: 'Amazon', search: searchAmazon },
  kabum: { label: 'Kabum', search: searchKabum },
  mercadolivre: { label: 'Mercado Livre', search: searchMercadoLivre },
};

/** Pausa entre requisições para não sobrecarregar as lojas. */
const POLITE_DELAY_MS = 1500;

export async function scrapeWatch(watch: Watch, db: DbShape): Promise<ScrapeResult[]> {
  const jobs: { source: string; run: () => Promise<Offer[]> }[] = [];
  if (watch.query) {
    for (const id of watch.stores) {
      const store = STORES[id];
      if (store) jobs.push({ source: store.label, run: () => store.search(watch.query!, db) });
    }
  }
  for (const url of watch.urls) {
    jobs.push({ source: url, run: () => scrapeProductPage(url) });
  }

  const results: ScrapeResult[] = [];
  for (const [i, job] of jobs.entries()) {
    if (i > 0) await sleep(POLITE_DELAY_MS);
    try {
      const offers = (await job.run()).map((o) => ({ ...o, units: o.units ?? detectUnits(o.title) }));
      results.push({ source: job.source, offers });
    } catch (err) {
      results.push({ source: job.source, offers: [], error: (err as Error).message });
    }
  }
  return results;
}
