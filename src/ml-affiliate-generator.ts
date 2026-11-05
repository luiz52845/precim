import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gerador de links de afiliado do Mercado Livre (meli.la) — SÓ roda no seu PC.
 *
 * Não existe API oficial para gerar links de afiliado. Este módulo faz o mesmo que o
 * botão "Compartilhar" do site faz quando você está logado: usa os cookies da SUA sessão
 * para chamar a rota interna de criação de links. Por isso:
 *  - os cookies ficam num arquivo local (ml-cookies.json, fora do git) e nunca vão para a Vercel;
 *  - as chamadas saem da sua internet, uma por vez, com pausa entre elas;
 *  - se o Mercado Livre recusar (sessão expirada/verificação), para tudo e avisa.
 * É uma rota não documentada: pode parar de funcionar se o Mercado Livre mudar o site.
 */

const COOKIES_FILE = process.env.ML_COOKIES_FILE || join(import.meta.dirname, '..', 'ml-cookies.json');
const CREATE_LINK_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/links';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CSRF_PATTERNS = [/csrfToken[^"]*"([^"]+)"/, /name="csrf-token"\s+content="([^"]+)"/];

/** O Mercado Livre recusou a sessão: cookies expirados ou conta pedindo verificação. */
export class MlSessionError extends Error {}

/** true quando o Precim está rodando no seu PC (npm start), e não na Vercel. */
export const isLocal = () => process.env.PRECIM_LOCAL === '1';

interface CookieEntry {
  name: string;
  value: string;
}

/**
 * Aceita o JSON exportado pela extensão do Chrome ("Export cookie JSON file") ou o texto
 * do cabeçalho Cookie ("nome=valor; nome2=valor2"). Guarda só nome/valor.
 */
function parseCookies(input: string): CookieEntry[] {
  const text = input.trim();
  if (!text) throw new Error('cole os cookies exportados do Mercado Livre');
  let list: CookieEntry[];
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('o JSON dos cookies está incompleto ou inválido; copie o arquivo inteiro');
    }
    list = (parsed as any[])
      .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string')
      .filter((c) => !c.domain || /mercadoli(vre|bre)/.test(String(c.domain)))
      .map((c) => ({ name: c.name, value: c.value }));
  } else {
    list = text
      .replace(/^cookie:\s*/i, '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return { name: p.slice(0, i), value: p.slice(i + 1) };
      })
      .filter((c) => c.name);
  }
  if (list.length < 3) throw new Error('poucos cookies encontrados; exporte com você logado em mercadolivre.com.br');
  return list;
}

export function saveCookies(input: string): number {
  if (!isLocal()) throw new Error('os cookies só podem ser salvos com o Precim rodando no seu PC');
  const list = parseCookies(input);
  writeFileSync(COOKIES_FILE, JSON.stringify(list, null, 2));
  return list.length;
}

export function cookiesStatus(): { configured: boolean; count?: number; savedAt?: string } {
  if (!isLocal() || !existsSync(COOKIES_FILE)) return { configured: false };
  try {
    const list = JSON.parse(readFileSync(COOKIES_FILE, 'utf8')) as CookieEntry[];
    return { configured: list.length > 0, count: list.length, savedAt: statSync(COOKIES_FILE).mtime.toISOString() };
  } catch {
    return { configured: false };
  }
}

function cookieHeader(): { header: string; csrfCookie?: string } {
  if (!isLocal()) throw new Error('o gerador de links só roda com o Precim no seu PC');
  if (!existsSync(COOKIES_FILE)) throw new MlSessionError('cookies do Mercado Livre não configurados (Configurações)');
  const list = JSON.parse(readFileSync(COOKIES_FILE, 'utf8')) as CookieEntry[];
  return {
    header: list.map((c) => `${c.name}=${c.value}`).join('; '),
    csrfCookie: list.find((c) => c.name === '_csrf')?.value,
  };
}

/** Pega o token CSRF da página do produto (o site exige esse token na criação do link). */
async function csrfToken(productUrl: string, cookie: string, fallback?: string): Promise<string> {
  try {
    const res = await fetch(productUrl, {
      headers: { cookie, 'user-agent': USER_AGENT, 'accept-language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(20_000),
    });
    if (/account-verification|\/login/.test(res.url)) {
      throw new MlSessionError('o Mercado Livre pediu login/verificação: exporte os cookies de novo');
    }
    const html = await res.text();
    for (const re of CSRF_PATTERNS) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
  } catch (err) {
    if (err instanceof MlSessionError) throw err;
  }
  if (fallback) return fallback;
  throw new Error('não encontrei o token de segurança (CSRF) na página do produto');
}

/** Gera o link meli.la de um produto. `tag` é o seu identificador (matt_word). */
export async function createMlAffiliateLink(productUrl: string, tag: string): Promise<string> {
  const { header, csrfCookie } = cookieHeader();
  const token = await csrfToken(productUrl, header, csrfCookie);
  const res = await fetch(CREATE_LINK_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-csrf-token': token,
      cookie: header,
      referer: productUrl,
      origin: new URL(productUrl).origin,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ url: productUrl, tag }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new MlSessionError(`o Mercado Livre recusou a sessão (HTTP ${res.status}): exporte os cookies de novo`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 150)}`);
  let data: { short_url?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('resposta inesperada do Mercado Livre');
  }
  if (!data.short_url) throw new Error(`resposta sem link: ${text.slice(0, 150)}`);
  return data.short_url;
}
