/**
 * Servidor local (npm start). Na Vercel o app é carregado por api/index.js e
 * as verificações automáticas ficam por conta do Vercel Cron.
 */
import app from './app.ts';
import { checkBatch } from './monitor.ts';

const PORT = Number(process.env.PORT) || 3000;
// Só escuta em localhost por padrão: o painel guarda tokens dos bots.
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Precim rodando em http://localhost:${PORT}`);
});

// A cada minuto, verifica os produtos cujo intervalo (definido em Configurações) já passou.
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await checkBatch({ onlyDue: true, budgetMs: 10 * 60_000 });
  } catch (err) {
    console.error('Erro na verificação automática:', err);
  } finally {
    running = false;
  }
}, 60_000);
