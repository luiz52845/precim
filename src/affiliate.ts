import type { DbShape } from './types.ts';

/**
 * Links de afiliado do Mercado Livre.
 *
 * O link de afiliado "final" (meli.la/...) só é gerado pelo botão Compartilhar do site,
 * com o usuário logado; não há API pública para isso. Então:
 *  1. Por produto: o usuário gera o meli.la uma vez e cola no Precim (affiliateLinks).
 *     Esse link passa a ser usado no painel e nas notificações daquele produto.
 *  2. Sem link salvo: usamos a página do produto com o identificador de afiliado
 *     (matt_word), que é onde o usuário clica em Compartilhar para gerar o link final.
 *
 * O banco guarda os links originais das ofertas; a troca é feita só na exibição/envio.
 */

type AffiliateCtx = Pick<DbShape, 'settings' | 'affiliateLinks'>;

const ML_HOSTS = /(^|\.)mercadoli(vre|bre)\.com(\.br)?$/;
/** Domínio dos links curtos de afiliado gerados pelo botão Compartilhar. */
const SHORT_HOSTS = /^meli\.la$/;

/** Extrai os parâmetros de um link de afiliado colado ou de um texto "a=1&b=2". */
export function parseAffiliateInput(input: string): string {
  const text = input.trim();
  if (!text) return '';
  // Só a etiqueta (como aparece em "Etiqueta em uso" no ML): "luizfernandes91".
  if (/^[\w.-]+$/.test(text)) return new URLSearchParams({ matt_word: text }).toString();
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

/**
 * Valida o link de afiliado final colado pelo usuário para um produto.
 * Aceita links curtos do ML (meli.la/...) ou links do ML com parâmetros de afiliado.
 */
export function validateProductAffiliateLink(link: string): string {
  const text = link.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('cole o link completo, começando com https://');
  }
  if (url.protocol !== 'https:') throw new Error('o link precisa começar com https://');
  if (SHORT_HOSTS.test(url.hostname)) return url.toString();
  // Endereço completo para onde o meli.la leva: tem o identificador (matt_*) e o
  // código "ref" do produto. Só matt_word não basta: é a página para gerar o link.
  const keys = [...url.searchParams.keys()];
  if (ML_HOSTS.test(url.hostname) && keys.some((k) => /^matt_/i.test(k)) && keys.includes('ref')) {
    return url.toString();
  }
  throw new Error('isso não parece um link de afiliado do Mercado Livre (esperado: https://meli.la/...)');
}

/** Link com o identificador de afiliado (matt_word), para abrir a página e gerar o link final. */
export function affiliateParamUrl(url: string, ctx: AffiliateCtx): string {
  const params = ctx.settings.affiliate?.mlParams;
  if (!params || !isMercadoLivreUrl(url)) return url;
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Melhor link para divulgar: o link final salvo (meli.la) ou, sem ele, o link com matt_word. */
export function affiliateUrl(url: string, ctx: AffiliateCtx): string {
  return ctx.affiliateLinks[url] ?? affiliateParamUrl(url, ctx);
}

export interface AffiliateInfo {
  /** Link original da oferta (chave para salvar o link de afiliado). */
  rawUrl: string;
  /** Link da página com o identificador de afiliado, para gerar o link final. */
  shareUrl?: string;
  /** true quando já existe link final de afiliado salvo para este produto. */
  hasAffiliateLink?: boolean;
}

/** Aplica o link de afiliado a qualquer objeto com `url` (sem alterar o original). */
export function withAffiliate<T extends { url: string }>(item: T, ctx: AffiliateCtx): T & AffiliateInfo {
  const ml = isMercadoLivreUrl(item.url);
  return {
    ...item,
    url: affiliateUrl(item.url, ctx),
    rawUrl: item.url,
    shareUrl: ml ? affiliateParamUrl(item.url, ctx) : undefined,
    hasAffiliateLink: ml ? Boolean(ctx.affiliateLinks[item.url]) : undefined,
  };
}
