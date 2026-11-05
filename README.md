# Precim

Monitor de preços: acompanha produtos em lojas online e manda mensagem no **Telegram** e/ou **WhatsApp** quando aparece uma oferta interessante.

## Como rodar

Requer Node.js 24 (localmente roda TypeScript direto, sem build).

```bash
npm install
npm start          # abre em http://localhost:3000
npm run dev        # mesmo, reiniciando ao editar o código
npm run check      # verifica todos os produtos uma vez e sai
npm run typecheck
npm run build      # compila para dist/ (usado pela Vercel)
```

## Deploy na Vercel

1. **Suba o código para o GitHub** e, na Vercel, clique em **Add New → Project** e importe o repositório. As configurações já estão em `vercel.json`, não precisa mudar nada no formulário.
2. **Banco de dados:** no projeto, abra **Storage → Create Database → Upstash (Redis)**, plano Free, e conecte ao projeto. As variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` são criadas sozinhas.
3. **Variáveis de ambiente** (Settings → Environment Variables):
   - `APP_PASSWORD`: a senha do painel;
   - `CRON_SECRET`: um texto aleatório longo;
   - `ML_CLIENT_ID` e `ML_CLIENT_SECRET`: App ID e chave secreta do app no Dev Center do Mercado Livre.
4. **Faça um novo deploy** (Deployments → Redeploy) para as variáveis valerem.

**Verificações automáticas:** o Vercel Cron chama `/api/cron` uma vez por dia às 11:00 UTC (08:00 de Brasília), que é o limite do plano gratuito. Para verificar com mais frequência sem pagar, use um agendador externo (ex.: cron-job.org) chamando `GET https://SEU-PROJETO.vercel.app/api/cron` com o cabeçalho `Authorization: Bearer <CRON_SECRET>`. Só são verificados os produtos cujo intervalo (definido em Configurações) já passou.

Cada chamada verifica produtos por até ~40 segundos. Se houver muitos, os restantes ficam para a próxima chamada.

## Links de afiliado do Mercado Livre (gerados no seu PC)

O Mercado Livre não tem API oficial para gerar links de afiliado (`meli.la`). O botão **Gerar links de afiliado (ML)** faz o mesmo que o botão *Compartilhar* do site, usando os **cookies da sua sessão**. Por segurança, isso **só roda com o Precim no seu PC**: os cookies ficam em `ml-cookies.json` (fora do git) e nunca vão para a Vercel.

1. No `.env`, preencha `APP_PASSWORD` e as credenciais do banco da Vercel, `KV_REST_API_URL` e `KV_REST_API_TOKEN`. Elas ficam em Vercel → precim → Storage → banco Upstash → aba `.env.local` → *Show secret*. Assim o Precim no PC usa os mesmos dados da Vercel.
2. `npm start` e abra http://localhost:3000.
3. Em **Configurações → Gerador automático de links**, cole os cookies do Mercado Livre exportados do Chrome (JSON de uma extensão de exportar cookies), com você logado.
4. Na aba **Produtos**, clique em **Gerar links de afiliado (ML)**. Os links aparecem também em https://precim.vercel.app.

Riscos: é uma rota não oficial (pode parar de funcionar se o site mudar) e automação pode contrariar as regras do programa de afiliados. Quando a sessão expirar, o gerador para e pede cookies novos.

## Como funciona

1. **Adicione um produto** na interface:
   - **Busca**: um termo (ex.: `iphone 15 128gb`) pesquisado nas lojas marcadas, e/ou
   - **Links**: páginas de produto de qualquer loja. O preço é lido dos dados estruturados da página (JSON-LD / meta tags).
2. **Filtros** descartam resultados errados: todas as palavras da busca precisam aparecer no título, mais as *palavras obrigatórias*; *palavras excluídas* (capa, película…) e a faixa de preço eliminam acessórios.
3. **Quando avisar**: se o preço chegar ao **preço alvo** ou ficar **X% abaixo da média** dos últimos 30 dias (precisa de pelo menos 3 verificações).
4. A verificação roda sozinha a cada N minutos (padrão: 60). A mesma oferta só gera um novo aviso se o preço cair mais ou depois de 24h.

## Lojas

| Loja | Situação |
|---|---|
| Kabum | ✅ busca funciona (lê o JSON embutido na página) |
| Amazon | ⚠️ funciona às vezes; a Amazon devolve 503 para acesso automatizado com frequência |
| Links de produto | ✅ em lojas que publicam dados estruturados e não bloqueiam robôs |
| Mercado Livre | ✅ pela API oficial: busca no catálogo (`/products/search`) e preço das ofertas (`/products/{id}/items`). A busca comum `/sites/MLB/search` é restrita (403) |
| Magalu, Casas Bahia, Pichau, Terabyte, Shopee | ❌ bloqueiam acesso automatizado (403 / anti-bot) |

O projeto **não tenta contornar** proteções anti-bot. Para a Shopee, o caminho é a API do programa de afiliados.

Na Vercel, as requisições saem de IPs de data center, e algumas lojas bloqueiam esses IPs mais do que uma internet residencial.

### Adicionar uma loja

Crie `src/scrapers/minhaloja.ts` exportando `async (query: string) => Offer[]` e registre em `STORES` em [src/scrapers/index.ts](src/scrapers/index.ts).

## Notificações

Configure na aba **Configurações** (ou no `.env`, ver `.env.example`):

- **Telegram**: fale com `@BotFather`, envie `/newbot` e copie o token. Mande qualquer mensagem para o seu bot e clique em **Descobrir** para preencher o chat ID.
- **WhatsApp**: usa o [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/), gratuito para uso pessoal. Autorize o seu número conforme as instruções do site para receber a API key.

Use **Enviar mensagem de teste** para conferir.

## Dados

Produtos, histórico, alertas, configurações e tokens ficam num único documento JSON: no **Upstash Redis** quando as variáveis dele existem (Vercel), ou em `data/db.json` localmente. Localmente o servidor só escuta em `127.0.0.1`; defina `APP_PASSWORD` para exigir login também localmente.

## Estrutura

```
api/index.js         função serverless da Vercel (carrega dist/app.js)
vercel.json          build, rotas, limite de tempo e cron
src/
  app.ts             API (Express): rotas e login
  server.ts          servidor local + agendador
  auth.ts            senha do painel, sessão e autorização do cron
  monitor.ts         verificação em lotes e regras de alerta
  deals.ts           filtro de relevância e regra de "oferta interessante"
  db.ts              armazenamento (Upstash Redis ou arquivo)
  notify/index.ts    Telegram e WhatsApp
  scrapers/          Amazon, Kabum, Mercado Livre, página de produto genérica
public/              interface web (HTML/CSS/JS puro, servida pela CDN)
```
