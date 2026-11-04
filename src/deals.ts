import type { Offer, PricePoint, Watch } from './types.ts';

/** Minúsculas, sem acentos, só letras/números separados por espaço. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'a', 'o']);

const tokens = (text: string) => normalize(text).split(' ').filter((t) => t && !STOPWORDS.has(t));

/**
 * Filtra resultados de busca para manter só os que realmente são o produto:
 * todas as palavras da busca + obrigatórias no título, nenhuma palavra excluída,
 * dentro da faixa de preço e disponível.
 */
export function filterRelevant(watch: Watch, offers: Offer[], fromSearch: boolean): Offer[] {
  const required = [...(fromSearch && watch.query ? tokens(watch.query) : []), ...watch.requiredWords.flatMap(tokens)];
  const excluded = watch.excludeWords.map(normalize).filter(Boolean);

  return offers.filter((o) => {
    if (!o.available) return false;
    if (watch.minPrice && o.price < watch.minPrice) return false;
    if (watch.maxPrice && o.price > watch.maxPrice) return false;
    const titleTokens = new Set(tokens(o.title));
    const title = ` ${normalize(o.title)} `;
    if (!required.every((w) => titleTokens.has(w))) return false;
    if (excluded.some((w) => title.includes(` ${w} `))) return false;
    return true;
  });
}

/** Média dos menores preços das verificações anteriores (últimos 30 dias). */
export function referencePrice(history: PricePoint[], watchId: string): number | undefined {
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const prices = history
    .filter((h) => h.watchId === watchId && Date.parse(h.at) >= since)
    .map((h) => h.price);
  if (prices.length < 3) return undefined; // pouco histórico para comparar
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

/** Decide se uma oferta é "interessante". Retorna o motivo, ou undefined. */
export function dealReason(watch: Watch, offer: Offer, reference: number | undefined): string | undefined {
  const reasons: string[] = [];
  if (watch.targetPrice && offer.price <= watch.targetPrice) {
    reasons.push(`preço alvo de ${brl(watch.targetPrice)} atingido`);
  }
  if (watch.dropPercent && reference) {
    const drop = ((reference - offer.price) / reference) * 100;
    if (drop >= watch.dropPercent) {
      reasons.push(`${drop.toFixed(0)}% abaixo da média recente (${brl(reference)})`);
    }
  }
  return reasons.length ? reasons.join(' e ') : undefined;
}

export const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
