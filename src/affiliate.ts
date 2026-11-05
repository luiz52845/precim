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
        'esse link não tem parâmetros de afiliado. Se for um link curto (meli.la), abra-o no navegador ' +
          'e cole aqui o endereço completo para onde ele leva (com "?matt_word=...").',
      );
    }
    params = url.searchParams;
  } else {
    params = new URLSearchParams(text.replace(/^\?/, ''));
  }
  // Só os parâmetros "matt_*" identificam o afiliado (matt_word, matt_tool). Os outros
  // são de navegação ou específicos de um produto (ex.: "ref", criptografado, vale só
  // para o produto em que o link foi gerado) e não podem ir para outros produtos.
  const kept = new URLSearchParams();
  for (const [k, v] of params) if (/^matt_/i.test(k) && v) kept.set(k, v);
  if (![...kept.keys()].length) {
    throw new Error('não encontrei o seu identificador de afiliado (parâmetro matt_word ou matt_tool) nesse link');
  }
  return kept.toString();
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
