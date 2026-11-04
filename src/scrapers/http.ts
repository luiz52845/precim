const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class BlockedError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Baixa uma página HTML. Em 429/503 (loja sobrecarregada ou limitando acessos) espera
 * alguns segundos e tenta mais uma vez. Lança BlockedError se a loja continuar recusando.
 */
export async function fetchHtml(url: string, timeoutMs = 20_000): Promise<string> {
  try {
    return await fetchOnce(url, timeoutMs);
  } catch (err) {
    if (!(err instanceof BlockedError) || err.status === 403) throw err;
    await sleep(8000);
    return fetchOnce(url, timeoutMs);
  }
}

async function fetchOnce(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new BlockedError(`a loja recusou o acesso automatizado (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Converte "R$ 4.199,90" / "4199.9" / 4199.9 em número. */
export function parsePrice(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  let s = value.replace(/[^\d.,]/g, '');
  if (!s) return undefined;
  if (s.includes(',')) {
    // Formato brasileiro: ponto = milhar, vírgula = decimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/\.\d{3}$/.test(s) && !/\.\d{1,2}$/.test(s)) {
    // "4.199" sem centavos -> milhar.
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
