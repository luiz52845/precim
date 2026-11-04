import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbShape, Settings } from './types.ts';

/**
 * Armazenamento do estado inteiro como um documento JSON.
 *  - Na Vercel (ou se as variáveis do Upstash existirem): Upstash Redis via REST.
 *  - Localmente: arquivo data/db.json.
 * Suficiente para uso pessoal; troque por Postgres se o volume crescer.
 */

const KEY = 'precim:db';
const MAX_HISTORY_PER_WATCH = 500;
const MAX_ALERTS = 300;

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const isVercel = Boolean(process.env.VERCEL);
export const storageKind: 'redis' | 'file' = redisUrl && redisToken ? 'redis' : 'file';

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const DB_FILE = join(DATA_DIR, 'db.json');

const defaultSettings = (): Settings => ({
  intervalMinutes: Number(process.env.INTERVAL_MINUTES) || 60,
  telegram: {
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },
  whatsapp: {
    enabled: Boolean(process.env.WHATSAPP_APIKEY),
    phone: process.env.WHATSAPP_PHONE ?? '',
    apiKey: process.env.WHATSAPP_APIKEY ?? '',
  },
});

function normalize(raw: Partial<DbShape> | null): DbShape {
  const def = defaultSettings();
  return {
    watches: raw?.watches ?? [],
    history: raw?.history ?? [],
    alerts: raw?.alerts ?? [],
    notified: raw?.notified ?? {},
    reports: raw?.reports ?? {},
    ml: raw?.ml,
    settings: {
      ...def,
      ...raw?.settings,
      telegram: { ...def.telegram, ...raw?.settings?.telegram },
      whatsapp: { ...def.whatsapp, ...raw?.settings?.whatsapp },
    },
  };
}

async function redis(command: unknown[]): Promise<unknown> {
  const res = await fetch(redisUrl!, {
    method: 'POST',
    headers: { authorization: `Bearer ${redisToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || body.error) throw new Error(`Upstash Redis: ${body.error ?? `HTTP ${res.status}`}`);
  return body.result;
}

export async function loadDb(): Promise<DbShape> {
  if (storageKind === 'redis') {
    const raw = (await redis(['GET', KEY])) as string | null;
    return normalize(raw ? JSON.parse(raw) : null);
  }
  if (isVercel) {
    throw new Error('banco de dados não configurado: conecte o Upstash Redis ao projeto na Vercel (Storage)');
  }
  return normalize(existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : null);
}

export async function saveDb(db: DbShape): Promise<void> {
  prune(db);
  const json = JSON.stringify(db);
  if (storageKind === 'redis') {
    await redis(['SET', KEY, json]);
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  // Gravação atômica (arquivo temporário + rename) para não corromper o JSON.
  writeFileSync(DB_FILE + '.tmp', json);
  renameSync(DB_FILE + '.tmp', DB_FILE);
}

/**
 * Lê o estado mais recente, aplica a alteração e grava. Usado em toda escrita para
 * reduzir o risco de uma requisição sobrescrever a outra (ex.: cron rodando enquanto
 * você edita um produto).
 */
export async function mutate<T>(fn: (db: DbShape) => T): Promise<T> {
  const db = await loadDb();
  const result = fn(db);
  await saveDb(db);
  return result;
}

/** Poda histórico e alertas para o documento não crescer sem limite. */
function prune(db: DbShape): void {
  const counts = new Map<string, number>();
  for (let i = db.history.length - 1; i >= 0; i--) {
    const id = db.history[i].watchId;
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    if (n > MAX_HISTORY_PER_WATCH) db.history.splice(i, 1);
  }
  if (db.alerts.length > MAX_ALERTS) db.alerts.splice(0, db.alerts.length - MAX_ALERTS);
  const ids = new Set(db.watches.map((w) => w.id));
  for (const id of Object.keys(db.reports)) if (!ids.has(id)) delete db.reports[id];
}

export const newId = (): string => crypto.randomUUID().slice(0, 8);
