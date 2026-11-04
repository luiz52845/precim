import './env.ts';
import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import {
  authEnabled,
  isCronAuthorized,
  isLoggedIn,
  login,
  logout,
  randomToken,
  readCookie,
  requireLogin,
  setCookie,
} from './auth.ts';
import { isVercel, loadDb, mutate, newId, storageKind } from './db.ts';
import { checkBatch, checkWatch } from './monitor.ts';
import { notifyAll, telegramChats } from './notify/index.ts';
import { STORES } from './scrapers/index.ts';
import { mlAuthorizeUrl, mlConfigured, mlExchangeCode, mlRedirectUri } from './scrapers/mercadolivre.ts';
import type { DbShape, Settings, StoreId, Watch } from './types.ts';

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
    active: body.active !== false,
    createdAt: base?.createdAt ?? new Date().toISOString(),
    lastCheckAt: base?.lastCheckAt,
    lastError: base?.lastError,
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
      watches: db.watches.map((w) => ({ ...w, best: db.reports[w.id]?.best ?? lastBest(w.id) })),
      stores: Object.entries(STORES).map(([id, s]) => ({ id, label: s.label })),
      settings: db.settings,
      scheduleInfo: scheduleInfo(),
      storage: storageKind,
      authEnabled: authEnabled(),
      ml: {
        configured: mlConfigured(),
        connected: Boolean(db.ml),
        redirectUri: mlRedirectUri(req.get('host'), req.protocol),
      },
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
      report: db.reports[watch.id],
      history: db.history.filter((p) => p.watchId === watch.id),
      alerts: db.alerts.filter((a) => a.watchId === watch.id).slice(-20).reverse(),
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
    res.status(201).json({ watch, report });
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
    res.json(await checkWatch(db, findWatch(db, req.params.id)));
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
    res.json(db.alerts.slice(-100).reverse().map((a) => ({ ...a, watchName: names.get(a.watchId) })));
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
    };
    await mutate((d) => {
      d.settings = settings;
    });
    res.json({ settings });
  }),
);

app.post(
  '/api/notify/test',
  h(async (_req, res) => {
    const db = await loadDb();
    res.json(await notifyAll(db.settings, '✅ <b>Monitor de Preços</b>\nNotificações funcionando!'));
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

// ---------- Mercado Livre (OAuth) ----------

app.get('/api/ml/login', (req, res) => {
  if (!mlConfigured()) {
    res.status(400).send('Defina ML_CLIENT_ID e ML_CLIENT_SECRET nas variáveis de ambiente.');
    return;
  }
  const state = randomToken();
  setCookie(req, res, 'ml_state', state, 600);
  res.redirect(mlAuthorizeUrl(mlRedirectUri(req.get('host'), req.protocol), state));
});

app.get(
  '/api/ml/callback',
  h(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return res.redirect(`/?ml=erro&msg=${encodeURIComponent(error)}#config`);
    // O "state" impede que outra pessoa conecte a conta dela no seu painel (CSRF).
    if (!code || !state || state !== readCookie(req, 'ml_state')) {
      return res.redirect('/?ml=erro&msg=' + encodeURIComponent('autorização inválida ou expirada, tente de novo') + '#config');
    }
    setCookie(req, res, 'ml_state', '', 0);
    const tokens = await mlExchangeCode(code, mlRedirectUri(req.get('host'), req.protocol));
    await mutate((d) => {
      d.ml = tokens;
    });
    res.redirect('/?ml=ok#config');
  }),
);

app.post(
  '/api/ml/disconnect',
  h(async (_req, res) => {
    await mutate((d) => {
      delete d.ml;
    });
    res.json({ ok: true });
  }),
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof BadRequest ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

export default app;
