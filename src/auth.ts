import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { isVercel } from './db.ts';

/**
 * Login por senha única (APP_PASSWORD). A sessão é um cookie HttpOnly assinado com HMAC;
 * trocar a senha invalida todas as sessões.
 * Localmente, sem APP_PASSWORD, o login é desativado (o servidor só escuta em 127.0.0.1).
 */

const COOKIE = 'mp_session';
const SESSION_DAYS = 30;

const password = () => process.env.APP_PASSWORD ?? '';
export const authEnabled = () => Boolean(password()) || isVercel;

const key = () => createHash('sha256').update(`mp:${password()}:${process.env.SESSION_SECRET ?? ''}`).digest();
const sign = (value: string) => createHmac('sha256', key()).update(value).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setCookie(req: Request, res: Response, name: string, value: string, maxAgeSec: number): void {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`,
  );
}

export function isLoggedIn(req: Request): boolean {
  if (!authEnabled()) return true;
  if (!password()) return false;
  const [exp, sig] = (readCookie(req, COOKIE) ?? '').split('.');
  return Boolean(exp && sig) && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}

export async function login(req: Request, res: Response): Promise<void> {
  if (!password()) {
    res.status(503).json({ error: 'defina a variável de ambiente APP_PASSWORD na Vercel' });
    return;
  }
  if (!safeEqual(String(req.body?.password ?? ''), password())) {
    await new Promise((r) => setTimeout(r, 800)); // freia tentativas de adivinhar a senha
    res.status(401).json({ error: 'senha incorreta' });
    return;
  }
  const exp = String(Date.now() + SESSION_DAYS * 86400_000);
  setCookie(req, res, COOKIE, `${exp}.${sign(exp)}`, SESSION_DAYS * 86400);
  res.json({ ok: true });
}

export function logout(req: Request, res: Response): void {
  setCookie(req, res, COOKIE, '', 0);
  res.json({ ok: true });
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (isLoggedIn(req)) return next();
  res.status(401).json({ error: 'login necessário', needsLogin: true, passwordSet: Boolean(password()) });
}

/**
 * Autoriza chamadas do cron. A Vercel envia "Authorization: Bearer <CRON_SECRET>"
 * automaticamente quando CRON_SECRET está definido. Agendadores externos
 * (cron-job.org, GitHub Actions) podem mandar o mesmo cabeçalho.
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !isVercel; // localmente, sem segredo, libera
  return safeEqual(req.headers.authorization ?? '', `Bearer ${secret}`);
}

