import type { Settings } from '../types.ts';

/** Envia mensagem pelo bot do Telegram (https://core.telegram.org/bots/api#sendmessage). */
export async function sendTelegram(cfg: Settings['telegram'], text: string): Promise<void> {
  if (!cfg.botToken || !cfg.chatId) throw new Error('Telegram: informe o token do bot e o chat_id');
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new Error(`Telegram: ${body.description ?? `HTTP ${res.status}`}`);
}

/**
 * Lista os chats que mandaram mensagem recente para o bot, para descobrir o chat_id.
 * O usuário precisa enviar qualquer mensagem ao bot antes.
 */
export async function telegramChats(botToken: string): Promise<{ id: number; name: string }[]> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { ok: boolean; description?: string; result?: any[] };
  if (!body.ok) throw new Error(`Telegram: ${body.description}`);
  const chats = new Map<number, string>();
  for (const u of body.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (chat) chats.set(chat.id, chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' '));
  }
  return [...chats].map(([id, name]) => ({ id, name }));
}

/**
 * WhatsApp via CallMeBot (gratuito, para uso pessoal): https://www.callmebot.com/blog/free-api-whatsapp-messages/
 * É preciso autorizar o bot uma vez pelo WhatsApp para receber a apikey.
 */
export async function sendWhatsApp(cfg: Settings['whatsapp'], text: string): Promise<void> {
  if (!cfg.phone || !cfg.apiKey) throw new Error('WhatsApp: informe o telefone e a apikey do CallMeBot');
  const plain = text.replace(/<[^>]+>/g, ''); // CallMeBot não entende HTML
  const url =
    'https://api.callmebot.com/whatsapp.php?' +
    new URLSearchParams({ phone: cfg.phone.replace(/[^\d+]/g, ''), text: plain, apikey: cfg.apiKey });
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const visible = (await res.text())
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!res.ok || /error|invalid|not (yet )?activated/i.test(visible)) {
    throw new Error(`WhatsApp (CallMeBot): HTTP ${res.status} ${visible.slice(0, 150)}`);
  }
}

/** Envia para todos os canais habilitados. Nunca lança: devolve sucessos e erros. */
export async function notifyAll(settings: Settings, text: string): Promise<{ sent: string[]; errors: string[] }> {
  const sent: string[] = [];
  const errors: string[] = [];
  const channels: [string, boolean, () => Promise<void>][] = [
    ['telegram', settings.telegram.enabled, () => sendTelegram(settings.telegram, text)],
    ['whatsapp', settings.whatsapp.enabled, () => sendWhatsApp(settings.whatsapp, text)],
  ];
  for (const [name, enabled, send] of channels) {
    if (!enabled) continue;
    try {
      await send();
      sent.push(name);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (!sent.length && !errors.length) errors.push('nenhum canal de notificação habilitado');
  return { sent, errors };
}
