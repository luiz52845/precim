import { loadDb, mutate, newId } from './db.ts';
import { affiliateUrl } from './affiliate.ts';
import { brl, dealReason, effectivePrice, filterRelevant, referencePrice } from './deals.ts';
import { notifyAll } from './notify/index.ts';
import { scrapeWatch } from './scrapers/index.ts';
import type { Alert, CheckReport, DbShape, Offer, Watch } from './types.ts';

/** Re-alerta a mesma oferta só se o preço cair mais ou após este intervalo. */
const REALERT_AFTER_MS = 24 * 3600 * 1000;

/**
 * Verifica um produto: busca nas lojas, filtra, decide alertas e envia as mensagens.
 * Lê `db` (histórico, configurações) mas grava o resultado com mutate() no estado mais
 * recente, para não perder alterações feitas enquanto a verificação rodava.
 */
export async function checkWatch(db: DbShape, watch: Watch): Promise<CheckReport> {
  const at = new Date().toISOString();
  const results = await scrapeWatch(watch, db);

  const offers: Offer[] = [];
  const sources = results.map((r) => {
    const fromSearch = !watch.urls.includes(r.source);
    const relevant = filterRelevant(watch, r.offers, fromSearch);
    offers.push(...relevant);
    return { source: r.source, found: r.offers.length, relevant: relevant.length, error: r.error };
  });
  // Preço de comparação: total, ou por unidade se o produto estiver nesse modo.
  const price = (o: Offer) => effectivePrice(watch, o);
  offers.sort((a, b) => price(a) - price(b));
  const best = offers[0];

  // Referência calculada ANTES de registrar o preço atual.
  const reference = referencePrice(db.history, watch.id);
  const noChannel = !db.settings.telegram.enabled && !db.settings.whatsapp.enabled;
  const alerts: Alert[] = [];
  const notified: DbShape['notified'] = {};

  for (const offer of offers) {
    const reason = dealReason(watch, offer, reference);
    if (!reason) break; // ordenado por preço: se este não serve, os próximos também não
    const prev = db.notified[offer.url];
    const recent = prev && Date.now() - Date.parse(prev.at) < REALERT_AFTER_MS;
    if (prev && price(offer) >= prev.price && recent) continue;

    const { sent, errors } = await notifyAll(db.settings, formatMessage(watch, offer, reason, db));
    alerts.push({ id: newId(), watchId: watch.id, at, offer, reason, sent, errors });
    // Se o envio falhou, tenta de novo na próxima verificação; se não há canal
    // configurado, registra mesmo assim para não repetir o alerta a cada rodada.
    if (sent.length || noChannel) notified[offer.url] = { price: price(offer), at };
    if (alerts.length >= 3) break; // no máximo 3 mensagens por verificação
  }

  const errors = sources.filter((s) => s.error).map((s) => `${s.source}: ${s.error}`);
  const report: CheckReport = { watchId: watch.id, at, sources, offers: offers.slice(0, 30), best, alerts };

  await mutate((d) => {
    const w = d.watches.find((x) => x.id === watch.id);
    if (!w) return; // excluído durante a verificação
    w.lastCheckAt = at;
    w.lastError = errors.length ? errors.join(' | ') : undefined;
    if (best) d.history.push({ watchId: w.id, at, price: price(best), store: best.store, title: best.title, url: best.url });
    d.alerts.push(...alerts);
    Object.assign(d.notified, notified);
    d.reports[w.id] = report;
  });
  return report;
}

function formatMessage(watch: Watch, offer: Offer, reason: string, db: DbShape): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const old = offer.oldPrice && offer.oldPrice > offer.price ? ` <s>${brl(offer.oldPrice)}</s>` : '';
  const unit = offer.units && offer.units > 1 ? ` (${offer.units} un. · ${brl(offer.price / offer.units)}/un.)` : '';
  return [
    `🔥 <b>Oferta: ${esc(watch.name)}</b>`,
    esc(offer.title),
    `💰 <b>${brl(offer.price)}</b>${old}${unit} — ${esc(offer.store)}`,
    offer.badges?.length ? `🏷️ ${esc(offer.badges.join(' · '))}` : '',
    `📉 ${esc(reason)}`,
    // Link de afiliado (Mercado Livre), quando configurado.
    affiliateUrl(offer.url, db),
  ]
    .filter(Boolean)
    .join('\n');
}

export interface BatchResult {
  checked: { id: string; name: string; best?: number; alerts: number; error?: string }[];
  pending: number;
}

/**
 * Verifica vários produtos em sequência, dos mais antigos para os mais recentes,
 * parando ao chegar no limite de tempo (funções serverless têm duração máxima).
 * Os que sobrarem ficam para a próxima chamada.
 *
 * @param onlyDue só os produtos cujo intervalo de verificação já passou.
 */
export async function checkBatch({ onlyDue, budgetMs }: { onlyDue: boolean; budgetMs: number }): Promise<BatchResult> {
  const started = Date.now();
  const db = await loadDb();
  const interval = Math.max(5, db.settings.intervalMinutes) * 60_000;
  const lastAt = (w: Watch) => (w.lastCheckAt ? Date.parse(w.lastCheckAt) : 0);
  const queue = db.watches
    .filter((w) => w.active && (!onlyDue || Date.now() - lastAt(w) >= interval - 60_000))
    .sort((a, b) => lastAt(a) - lastAt(b));

  const checked: BatchResult['checked'] = [];
  for (const watch of queue) {
    if (Date.now() - started > budgetMs) break;
    try {
      const r = await checkWatch(db, watch);
      checked.push({ id: watch.id, name: watch.name, best: r.best?.price, alerts: r.alerts.length });
      console.log(`${watch.name}: melhor ${r.best ? `${brl(r.best.price)} (${r.best.store})` : '—'}, ${r.alerts.length} alerta(s)`);
    } catch (err) {
      checked.push({ id: watch.id, name: watch.name, alerts: 0, error: (err as Error).message });
      console.error(`Erro ao verificar ${watch.name}:`, err);
    }
  }
  return { checked, pending: queue.length - checked.length };
}
