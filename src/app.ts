import './env.ts';
import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import { authEnabled, isCronAuthorized, isLoggedIn, login, logout, requireLogin } from './auth.ts';
import { isVercel, loadDb, mutate, newId, storageKind } from './db.ts';
import { checkBatch, checkWatch } from './monitor.ts';
import { notifyAll, telegramChats } from './notify/index.ts';
import { STORES } from './scrapers/index.ts';
import { mlConfigured } from './scrapers/mercadolivre.ts';
import {
  MlNotAllowedError,
  MlSessionError,
  cookiesStatus,
  createMlAffiliateLinkForOffer,
  isLocal,
  saveCookies,
} from './ml-affiliate-generator.ts';
import { isAffiliateBlocked, isMercadoLivreUrl, parseAffiliateInput, validateProductAffiliateLink, withAffiliate } from './affiliate.ts';
import type { CheckReport, DbShape, Offer, Settings, StoreId, Watch } from './types.ts';

/** Tempo máximo gasto verificando produtos numa requisição (a função tem limite de 60s). */
const BATCH_BUDGET_MS = 40_000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));
// Na Vercel os arquivos de public/ são servidos pela CDN; localmente, pelo Express.
app.use(express.static(join(import.meta.dirname, '..', 'public')));

class BadRequest extends Error {}

// Envolve handlers async para que erros cheguem ao middleware de erro.
const h =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

// ---------- rotas públicas ----------

app.post('/api/login', h(login));
app.post('/api/logout', logout);

app.get(
  '/api/session',
  h((req, res) => {
    res.json({ loggedIn: isLoggedIn(req), authEnabled: authEnabled(), passwordSet: Boolean(process.env.APP_PASSWORD) });
  }),
);

/** Chamado pelo Vercel Cron (ver vercel.json) ou por um agendador externo. */
app.get(
  '/api/cron',
  h(async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'não autorizado' });
    res.json(await checkBatch({ onlyDue: true, budgetMs: BATCH_BUDGET_MS }));
  }),
);

// ---------- daqui para baixo, só com login ----------
app.use('/api', requireLogin);

const words = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 30);

const optNumber = (v: unknown): number | undefined => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`número inválido: ${v}`);
  return n || undefined;
};

/** Valida e normaliza o corpo recebido da interface. */
function parseWatch(body: any, base?: Watch): Watch {
  const query = String(body.query ?? '').trim() || undefined;
  const urls = words(String(body.urls ?? '').replace(/\s+/g, ',')).filter((u) => {
    try {
      return ['http:', 'https:'].includes(new URL(u).protocol);
    } catch {
      throw new BadRequest(`URL inválida: ${u}`);
    }
  });
  const stores = (Array.isArray(body.stores) ? body.stores : []).filter((s: string): s is StoreId => s in STORES);
  if (!query && !urls.length) throw new BadRequest('informe um termo de busca ou pelo menos um link de produto');
  if (query && !stores.length && !urls.length) throw new BadRequest('selecione pelo menos uma loja');

  return {
    id: base?.id ?? newId(),
    name: String(body.name ?? '').trim() || query || new URL(urls[0]).hostname,
    query,
    stores,
    urls,
    requiredWords: words(body.requiredWords),
    excludeWords: words(body.excludeWords),
    minPrice: optNumber(body.minPrice),
    maxPrice: optNumber(body.maxPrice),
    targetPrice: optNumber(body.targetPrice),
    dropPercent: optNumber(body.dropPercent),
    compareUnitPrice: body.compareUnitPrice === true || undefined,
    active: body.active !== false,
    createdAt: base?.createdAt ?? new Date().toISOString(),
    lastCheckAt: base?.lastCheckAt,
    lastError: base?.lastError,
  };
}

function parseAffiliate(input: string): string {
  try {
    return parseAffiliateInput(input);
  } catch (err) {
    throw new BadRequest(`Link de afiliado: ${(err as Error).message}`);
  }
}

/** Troca os links do relatório pelos links de afiliado (só na resposta; o banco guarda os originais). */
function affiliateReport(report: CheckReport | undefined, db: DbShape): CheckReport | undefined {
  if (!report) return report;
  return {
    ...report,
    offers: report.offers.map((o) => withAffiliate(o, db)),
    best: report.best && withAffiliate(report.best, db),
    alerts: report.alerts.map((a) => ({ ...a, offer: withAffiliate(a.offer, db) })),
  };
}

function findWatch(db: DbShape, id: string): Watch {
  const w = db.watches.find((x) => x.id === id);
  if (!w) throw new BadRequest('produto não encontrado');
  return w;
}

const scheduleInfo = () =>
  isVercel
    ? 'Verificação automática pelo Vercel Cron (veja o horário em vercel.json)'
    : 'Verificação automática enquanto o servidor estiver rodando';

app.get(
  '/api/state',
  h(async (req, res) => {
    const db = await loadDb();
    const lastBest = (id: string) => db.history.findLast((p) => p.watchId === id);
    res.json({
      watches: db.watches.map((w) => {
        const report = db.reports[w.id];
        const best = report?.best ?? lastBest(w.id);
        return {
          ...w,
          best: best && withAffiliate(best, db),
          offersCount: report?.offers.length ?? 0,
          // Ofertas do Mercado Livre ainda sem link de afiliado final.
          pendingLinks: (report?.offers ?? []).filter(
            (o) => isMercadoLivreUrl(o.url) && !db.affiliateLinks[o.url] && !isAffiliateBlocked(o.url, db),
          ).length,
          // Só mostra erro no cartão quando nenhuma loja respondeu.
          failed: Boolean(report && !report.offers.length && report.sources.some((s) => s.error)),
        };
      }),
      stores: Object.entries(STORES).map(([id, s]) => ({ id, label: s.label })),
      settings: db.settings,
      scheduleInfo: scheduleInfo(),
      storage: storageKind,
      authEnabled: authEnabled(),
      ml: { configured: mlConfigured() },
      generator: { local: isLocal(), cookies: cookiesStatus() },
    });
  }),
);

app.get(
  '/api/watches/:id',
  h(async (req, res) => {
    const db = await loadDb();
    const watch = findWatch(db, req.params.id);
    res.json({
      watch,
      report: affiliateReport(db.reports[watch.id], db),
      history: db.history.filter((p) => p.watchId === watch.id),
      alerts: db.alerts
        .filter((a) => a.watchId === watch.id)
        .slice(-20)
        .reverse()
        .map((a) => ({ ...a, offer: withAffiliate(a.offer, db) })),
    });
  }),
);

app.post(
  '/api/watches',
  h(async (req, res) => {
    const watch = parseWatch(req.body);
    const db = await mutate((d) => {
      d.watches.push(watch);
      return d;
    });
    // Primeira verificação imediata para já mostrar preços.
    const report = await checkWatch(db, watch);
    res.status(201).json({ watch, report: affiliateReport(report, db) });
  }),
);

app.put(
  '/api/watches/:id',
  h(async (req, res) => {
    const watch = await mutate((d) => {
      const old = findWatch(d, req.params.id);
      const updated = parseWatch(req.body, old);
      d.watches[d.watches.indexOf(old)] = updated;
      return updated;
    });
    res.json({ watch });
  }),
);

app.delete(
  '/api/watches/:id',
  h(async (req, res) => {
    await mutate((d) => {
      const watch = findWatch(d, req.params.id);
      d.watches = d.watches.filter((w) => w !== watch);
      d.history = d.history.filter((p) => p.watchId !== watch.id);
      d.alerts = d.alerts.filter((a) => a.watchId !== watch.id);
      delete d.reports[watch.id];
    });
    res.status(204).end();
  }),
);

app.post(
  '/api/watches/:id/check',
  h(async (req, res) => {
    const db = await loadDb();
    res.json(affiliateReport(await checkWatch(db, findWatch(db, req.params.id)), db));
  }),
);

app.post(
  '/api/check-all',
  h(async (_req, res) => {
    res.json(await checkBatch({ onlyDue: false, budgetMs: BATCH_BUDGET_MS }));
  }),
);

app.get(
  '/api/alerts',
  h(async (_req, res) => {
    const db = await loadDb();
    const names = new Map(db.watches.map((w) => [w.id, w.name]));
    res.json(
      db.alerts
        .slice(-100)
        .reverse()
        .map((a) => ({ ...a, offer: withAffiliate(a.offer, db), watchName: names.get(a.watchId) })),
    );
  }),
);

app.put(
  '/api/settings',
  h(async (req, res) => {
    const b = req.body as Partial<Settings>;
    const interval = Number(b.intervalMinutes);
    if (!Number.isFinite(interval) || interval < 5) throw new BadRequest('o intervalo mínimo é 5 minutos');
    const settings: Settings = {
      intervalMinutes: Math.round(interval),
      telegram: {
        enabled: Boolean(b.telegram?.enabled),
        botToken: String(b.telegram?.botToken ?? '').trim(),
        chatId: String(b.telegram?.chatId ?? '').trim(),
      },
      whatsapp: {
        enabled: Boolean(b.whatsapp?.enabled),
        phone: String(b.whatsapp?.phone ?? '').trim(),
        apiKey: String(b.whatsapp?.apiKey ?? '').trim(),
      },
      affiliate: { mlParams: parseAffiliate(String(b.affiliate?.mlParams ?? '')) },
    };
    await mutate((d) => {
      // A tela mostra só a etiqueta (matt_word): mantém o matt_tool já salvo se a etiqueta não mudou.
      const next = new URLSearchParams(settings.affiliate.mlParams);
      const prev = new URLSearchParams(d.settings.affiliate?.mlParams ?? '');
      if (next.get('matt_word') && next.get('matt_word') === prev.get('matt_word') && !next.has('matt_tool') && prev.get('matt_tool')) {
        next.set('matt_tool', prev.get('matt_tool')!);
        settings.affiliate.mlParams = next.toString();
      }
      d.settings = settings;
    });
    res.json({ settings });
  }),
);

app.post(
  '/api/notify/test',
  h(async (_req, res) => {
    const db = await loadDb();
    res.json(await notifyAll(db.settings, '✅ <b>Precim</b>\nNotificações funcionando!'));
  }),
);

/**
 * Salva (ou remove, com link vazio) o link de afiliado final de um produto do Mercado Livre.
 * Corpo: { productUrl: link original da oferta, link: "https://meli.la/..." }
 */
app.put(
  '/api/affiliate-links',
  h(async (req, res) => {
    const productUrl = String(req.body?.productUrl ?? '').trim();
    if (!isMercadoLivreUrl(productUrl)) throw new BadRequest('produto inválido: precisa ser um link do Mercado Livre');
    const raw = String(req.body?.link ?? '').trim();
    let link = '';
    if (raw) {
      try {
        link = validateProductAffiliateLink(raw);
      } catch (err) {
        throw new BadRequest((err as Error).message);
      }
    }
    await mutate((d) => {
      if (link) d.affiliateLinks[productUrl] = link;
      else delete d.affiliateLinks[productUrl];
    });
    res.json({ productUrl, link });
  }),
);

// ---------- gerador de links de afiliado (só no seu PC) ----------

app.put(
  '/api/local/ml-cookies',
  h(async (req, res) => {
    try {
      const count = saveCookies(String(req.body?.cookies ?? ''));
      res.json({ ok: true, count });
    } catch (err) {
      throw new BadRequest((err as Error).message);
    }
  }),
);

/** Pausa entre links gerados, para não sobrecarregar o Mercado Livre. */
const GENERATE_DELAY_MS = 2500;

/**
 * Gera o link meli.la de todas as ofertas do Mercado Livre (da última verificação de
 * cada produto) que ainda não têm link de afiliado. Grava cada link assim que gerado.
 */
app.post(
  '/api/affiliate/generate',
  h(async (req, res) => {
    if (!isLocal()) {
      throw new BadRequest('a geração automática de links só funciona com o Precim rodando no seu PC (npm start)');
    }
    const db = await loadDb();
    const tag = new URLSearchParams(db.settings.affiliate.mlParams).get('matt_word');
    if (!tag) throw new BadRequest('salve primeiro o seu link de afiliado em Configurações (para obter a sua tag)');

    const watchId = req.body?.watchId ? String(req.body.watchId) : undefined;
    // Uma oferta por produto do catálogo (a chave do link salvo é o link do produto).
    const offers = new Map<string, Offer>();
    for (const [id, report] of Object.entries(db.reports)) {
      if (watchId && id !== watchId) continue;
      for (const o of report.offers) {
        if (!isMercadoLivreUrl(o.url) || db.affiliateLinks[o.url] || offers.has(o.url)) continue;
        if (isAffiliateBlocked(o.url, db)) continue; // recusado pelo programa há pouco tempo
        offers.set(o.url, o);
      }
    }

    const generated: { url: string; link: string }[] = [];
    const failed: { url: string; error: string }[] = [];
    const blocked: string[] = [];
    let stopped: string | undefined;
    for (const [url, offer] of offers) {
      if (generated.length || failed.length || blocked.length) await new Promise((r) => setTimeout(r, GENERATE_DELAY_MS));
      try {
        const link = await createMlAffiliateLinkForOffer(offer, tag);
        await mutate((d) => {
          d.affiliateLinks[url] = link;
        });
        generated.push({ url, link });
        console.log(`link de afiliado: ${url} -> ${link}`);
      } catch (err) {
        if (err instanceof MlSessionError) {
          stopped = err.message;
          break;
        }
        if (err instanceof MlNotAllowedError) {
          // Produto fora do programa (ex.: fórmula infantil): marca e segue para o próximo.
          blocked.push(url);
          await mutate((d) => {
            d.affiliateBlocked[url] = new Date().toISOString();
          });
          console.log(`fora do programa de afiliados: ${url}`);
          continue;
        }
        failed.push({ url, error: (err as Error).message });
        if (failed.length >= 3 && !generated.length) {
          stopped = 'as 3 primeiras tentativas falharam; parei para não insistir';
          break;
        }
      }
    }
    res.json({
      total: offers.size,
      generated,
      blocked,
      failed,
      stopped,
      remaining: offers.size - generated.length - failed.length - blocked.length,
    });
  }),
);

app.post(
  '/api/telegram/chats',
  h(async (req, res) => {
    const token = String(req.body?.botToken ?? '').trim();
    if (!token) throw new BadRequest('informe o token do bot');
    res.json(await telegramChats(token));
  }),
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof BadRequest ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

export default app;
