import type { Settings } from './types.ts';

/**
 * Link de afiliado do Mercado Livre.
 *
 * O usuário cola nas Configurações um link de afiliado gerado no site do ML (ou só os
 * parâmetros dele). Guardamos apenas os parâmetros e os acrescentamos a todo link do
 * Mercado Livre exibido no painel ou enviado nas notificações. Os links "crus" continuam
 * no banco, para histórico e controle de alertas repetidos não dependerem disso.
 */

const ML_HOSTS = /(^|\.)mercadoli(vre|bre)\.com(\.br)?$/;

/** Extrai os parâmetros de um link de afiliado colado ou de um texto "a=1&b=2". */
export function parseAffiliateInput(input: string): string {
  const text = input.trim();
  if (!text) return '';
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    if (!url.search) {
      throw new Error(
        'esse link não tem parâmetros de afiliado (links curtos como meli.la não dão para reaproveitar). ' +
          'Gere o link de afiliado de um produto e cole o link completo, com "?" e os parâmetros.',
      );
    }
    params = url.searchParams;
  } else {
    params = new URLSearchParams(text.replace(/^\?/, ''));
  }
  // Remove parâmetros de navegação que não identificam o afiliado.
  for (const key of ['pdp_filters', 'searchVariation', 'position', 'search_layout', 'type', 'tracking_id']) {
    params.delete(key);
  }
  if (![...params.keys()].length) throw new Error('não encontrei parâmetros de afiliado nesse texto');
  return params.toString();
}

export function isMercadoLivreUrl(url: string): boolean {
  try {
    return ML_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Devolve o link com os parâmetros de afiliado, se for do Mercado Livre e houver configuração. */
export function affiliateUrl(url: string, settings: Settings): string {
  const params = settings.affiliate?.mlParams;
  if (!params || !isMercadoLivreUrl(url)) return url;
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Aplica o link de afiliado a qualquer objeto com `url` (sem alterar o original). */
export function withAffiliate<T extends { url: string }>(item: T, settings: Settings): T {
  return { ...item, url: affiliateUrl(item.url, settings) };
}
