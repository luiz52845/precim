import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Carrega o .env (se existir) antes de qualquer outro módulo ler process.env.
const envFile = join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
