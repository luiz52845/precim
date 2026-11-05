/** Lojas suportadas na busca por palavra-chave. */
export type StoreId = 'amazon' | 'kabum' | 'mercadolivre';

/** Um produto que o usuário quer acompanhar. */
export interface Watch {
  id: string;
  /** Nome amigável exibido na interface e nas mensagens. */
  name: string;
  /** Modo "busca": termo pesquisado nas lojas. */
  query?: string;
  /** Lojas em que a busca é feita (modo "busca"). */
  stores: StoreId[];
  /** Modo "link": URLs de páginas de produto (qualquer loja que exponha dados estruturados). */
  urls: string[];
  /** Palavras que o título PRECISA conter (além das palavras da busca). */
  requiredWords: string[];
  /** Palavras que descartam o resultado (ex.: "capa", "película"). */
  excludeWords: string[];
  /** Descarta resultados abaixo deste preço (útil para eliminar acessórios). */
  minPrice?: number;
  maxPrice?: number;
  /** Alerta quando o preço ficar igual ou abaixo deste valor. */
  targetPrice?: number;
  /** Alerta quando o preço cair X% em relação à média histórica. */
  dropPercent?: number;
  /**
   * Compara pelo preço por unidade (kits de N unidades viram preço/N). Nesse modo,
   * preço alvo, faixa de preço e histórico também passam a ser por unidade.
   */
  compareUnitPrice?: boolean;
  active: boolean;
  createdAt: string;
  lastCheckAt?: string;
  lastError?: string;
}

/** Um resultado encontrado em uma loja. */
export interface Offer {
  store: string;
  title: string;
  price: number;
  /** Preço "de" anunciado pela loja, quando disponível. */
  oldPrice?: number;
  url: string;
  image?: string;
  available: boolean;
  /** Quantidade de unidades detectada no título ("Kit 4 latas" -> 4). */
  units?: number;
  /** Destaques da oferta: frete grátis, Full, loja oficial... */
  badges?: string[];
  /** Mercado Livre: código do anúncio mais barato (ex.: "MLB2188453681"). */
  itemId?: string;
}

/** Registro do menor preço encontrado em uma verificação. */
export interface PricePoint {
  watchId: string;
  at: string;
  price: number;
  store: string;
  title: string;
  url: string;
}

export interface Alert {
  id: string;
  watchId: string;
  at: string;
  offer: Offer;
  reason: string;
  /** Canais em que o envio funcionou / falhou. */
  sent: string[];
  errors: string[];
}

export interface Settings {
  intervalMinutes: number;
  telegram: { enabled: boolean; botToken: string; chatId: string };
  whatsapp: { enabled: boolean; phone: string; apiKey: string };
  /** Parâmetros do link de afiliado do Mercado Livre (ex.: "matt_tool=123&matt_word=abc"). */
  affiliate: { mlParams: string };
}

export interface ScrapeResult {
  source: string;
  offers: Offer[];
  error?: string;
}

export interface CheckReport {
  watchId: string;
  at: string;
  sources: { source: string; found: number; relevant: number; error?: string }[];
  offers: Offer[];
  best?: Offer;
  alerts: Alert[];
}

export interface DbShape {
  watches: Watch[];
  history: PricePoint[];
  alerts: Alert[];
  /** Último preço notificado por URL de oferta, para não repetir alerta. */
  notified: Record<string, { price: number; at: string }>;
  /** Resultado da última verificação de cada produto. */
  reports: Record<string, CheckReport>;
  /** Link de afiliado final (meli.la) por link de produto do Mercado Livre. */
  affiliateLinks: Record<string, string>;
  settings: Settings;
}
