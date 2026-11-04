/**
 * Verifica todos os produtos ativos uma vez e sai (útil para o Agendador de Tarefas do Windows/cron).
 * Uso: npm run check
 */
import './env.ts';
import { checkBatch } from './monitor.ts';

const result = await checkBatch({ onlyDue: false, budgetMs: 30 * 60_000 });
console.log(`${result.checked.length} produto(s) verificado(s).`);
