import cron from 'node-cron';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { config } from '../config';
import { evaluateAll, AlertResult } from './alerts';
import { listTokens, getAlertActive, setAlertActive, removeToken } from './pushStore';

const expo = new Expo();

// Send one alert to every registered token (chunked, with receipt-aware cleanup).
async function sendToAll(alert: AlertResult): Promise<void> {
  const tokens = listTokens().filter((t) => Expo.isExpoPushToken(t));
  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    sound: 'default',
    title: alert.title,
    body: alert.body,
    priority: 'high',
    channelId: 'alerts',
    data: { alertId: alert.id },
  }));

  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          removeToken(chunk[i].to as string);
        }
      });
    } catch (err) {
      console.warn('[cron] push send failed:', (err as Error).message);
    }
  }
}

// Evaluate all triggers; fire only on the inactive→active rising edge.
export async function runAlertCycle(): Promise<{ fired: string[]; evaluated: AlertResult[] }> {
  const results = await evaluateAll();
  const fired: string[] = [];

  for (const r of results) {
    const was = getAlertActive(r.id);
    if (r.active && !was) {
      await sendToAll(r);
      fired.push(r.id);
    }
    setAlertActive(r.id, r.active);
  }

  if (fired.length) console.log(`[cron] fired alerts: ${fired.join(', ')}`);
  return { fired, evaluated: results };
}

export function startAlertCron(): void {
  if (!config.push.enabled) {
    console.log('[cron] push disabled (PUSH_ENABLED=false)');
    return;
  }
  if (!cron.validate(config.push.cron)) {
    console.warn(`[cron] invalid ALERT_CRON "${config.push.cron}" — alerts disabled`);
    return;
  }
  cron.schedule(config.push.cron, () => {
    runAlertCycle().catch((err) => console.warn('[cron] cycle error:', err.message));
  });
  console.log(`[cron] alert scheduler started (${config.push.cron})`);
}
