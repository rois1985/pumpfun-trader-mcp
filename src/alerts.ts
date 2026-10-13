import { config } from './config.js';
import type { PumpCollector } from './collector.js';
import type { SolPriceFeed } from './price.js';
import { rankTokens } from './scoring.js';

const log = (...a: unknown[]) => console.error('[alerts]', ...a);

export const telegramEnabled = () => Boolean(config.telegramBotToken && config.telegramChatId);

export async function sendTelegram(text: string): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) log('telegram HTTP', res.status);
  } catch (e) {
    log('telegram failed:', (e as Error).message);
  }
}

/** Push scanner alerts when a token crosses ALERT_MIN_SCORE. No-op unless Telegram is configured. */
export function startAlerts(collector: PumpCollector, price: SolPriceFeed): NodeJS.Timeout | undefined {
  if (!telegramEnabled()) return undefined;
  const lastAlert = new Map<string, number>();
  log(`scanner alerts enabled (min score ${config.alertMinScore})`);

  return setInterval(async () => {
    const now = Date.now();
    const leaders = rankTokens(
      collector.tokens.values(),
      { limit: 5, minScore: config.alertMinScore, minAgeSeconds: 60, maxAgeMinutes: 120, excludeRisky: true, includeMigrated: false },
      price.price,
    );
    for (const s of leaders) {
      if (now - (lastAlert.get(s.mint) ?? 0) < config.alertCooldownMinutes * 60_000) continue;
      lastAlert.set(s.mint, now);
      await sendTelegram(
        [
          `📈 ${s.label.toUpperCase()} ${s.score}/100 — $${s.symbol} (${s.name})`,
          `MC: ${s.mcapSol} SOL${s.mcapUsd ? ` (~$${s.mcapUsd.toLocaleString()})` : ''} | 5m: ${s.mcapChange5mPct}%`,
          `Net flow 5m: ${s.netFlowSol5m} SOL | buyers 5m: ${s.last5m.uniqueBuyers} | curve ${s.curveProgressPct}%`,
          `Top10: ${s.top10HoldersPct}% | flags: ${s.flags.join(', ') || 'none'}`,
          s.links.pumpfun,
          'Signal only — not a prediction.',
        ].join('\n'),
      );
    }
    for (const [mint, t] of lastAlert) if (now - t > 6 * 3600_000) lastAlert.delete(mint);
  }, 15_000);
}
