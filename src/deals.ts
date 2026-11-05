import type { Offer, PricePoint, Watch } from './types.ts';

/**
 * Minúsculas, sem acentos, só letras/números separados por espaço. Separa números de
 * letras ("128GB" -> "128 gb", "iPhone15" -> "iphone 15") para que "128gb" na busca
 * case com "128 GB" no título.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .trim();
}

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'a', 'o']);

const tokens = (text: string) => normalize(text).split(' ').filter((t) => t && !STOPWORDS.has(t));

const UNIT_WORDS =
  'unidades|unidade|unid|un|latas|lata|pacotes|pacote|caixas|caixa|frascos|frasco|potes|pote|refis|refil|garrafas|garrafa|pecas|rolos|sachês|saches|sacos|fardos';

/**
 * Detecta quantas unidades o anúncio tem pelo título: "Kit 4 Latas", "Kit com 3",
 * "6 unidades", "c/ 2 latas". Devolve 1 quando não encontra nada.
 * Números com unidade de medida ("800g", "1kg") não contam como quantidade.
 */
export function detectUnits(title: string): number {
  const t = normalize(title);
  const patterns = [
    new RegExp(`\\bkit (?:com |c )?(\\d{1,2})\\b`),
    new RegExp(`\\b(\\d{1,2}) (?:${UNIT_WORDS})\\b`),
    /\b(?:com|c) (\d{1,2}) (?:un|unid|unidades)\b/,
  ];
  for (const re of patterns) {
    const n = Number(t.match(re)?.[1]);
    if (n >= 2 && n <= 48) return n;
  }
  return 1;
}

/** Preço usado para comparar: total ou por unidade, conforme o produto monitorado. */
export function effectivePrice(watch: Watch, offer: Offer): number {
  return watch.compareUnitPrice && offer.units && offer.units > 1 ? offer.price / offer.units : offer.price;
}

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
    const price = effectivePrice(watch, o);
    if (watch.minPrice && price < watch.minPrice) return false;
    if (watch.maxPrice && price > watch.maxPrice) return false;
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
  const price = effectivePrice(watch, offer);
  const per = watch.compareUnitPrice ? ' por unidade' : '';
  if (watch.targetPrice && price <= watch.targetPrice) {
    reasons.push(`preço alvo de ${brl(watch.targetPrice)}${per} atingido`);
  }
  if (watch.dropPercent && reference) {
    const drop = ((reference - price) / reference) * 100;
    if (drop >= watch.dropPercent) {
      reasons.push(`${drop.toFixed(0)}% abaixo da média recente (${brl(reference)})`);
    }
  }
  return reasons.length ? reasons.join(' e ') : undefined;
}

export const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
