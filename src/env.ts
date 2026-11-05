import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

// Carrega variáveis locais antes de qualquer outro módulo ler process.env.
//  - .env.local: variáveis de produção baixadas da Vercel
//    (`vercel env pull .env.local --environment=production`), para o Precim no seu PC
//    usar o mesmo banco da Vercel;
//  - .env: suas variáveis locais.
// Quem é carregado primeiro vence; variáveis já definidas no ambiente nunca são trocadas.
// As variáveis de sistema da Vercel (VERCEL*, TURBO*, NX_*) são ignoradas: senão o
// Precim no seu PC acharia que está rodando na Vercel.
const SYSTEM_VARS = /^(VERCEL|TURBO|NX_)/;

for (const name of ['.env.local', '.env']) {
  const file = join(import.meta.dirname, '..', name);
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    // Variáveis secretas não podem ser baixadas da Vercel: vêm como "[SENSITIVE]".
    if (SYSTEM_VARS.test(key) || value === '[SENSITIVE]' || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}
