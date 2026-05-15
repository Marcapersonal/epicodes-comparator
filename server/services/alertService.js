const nodemailer = require('nodemailer');
const TelegramBot = require('node-telegram-bot-api');
const { getDb, getSetting } = require('../db/database');

function getTransport() {
  const host = getSetting('smtp_host') || process.env.SMTP_HOST;
  const port = parseInt(getSetting('smtp_port') || process.env.SMTP_PORT || '587', 10);
  const user = getSetting('smtp_user') || process.env.SMTP_USER;
  const pass = getSetting('smtp_pass') || process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

function getTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try { return new TelegramBot(token); } catch (_) { return null; }
}

function getTelegramChatId() {
  return getSetting('telegram_chat') || process.env.TELEGRAM_CHAT_ID;
}

async function sendAlert({ watchlistId, gameName, oldPrice, newPrice, psdealsUrl }) {
  const saving = oldPrice ? oldPrice - newPrice : 0;
  const msg = [
    `🎮 *Epicodes — Alerta de Precio*`,
    ``,
    `*${gameName}*`,
    `💰 Nuevo precio real: *$${newPrice.toFixed(2)} USD*`,
    oldPrice ? `📉 Bajó de $${oldPrice.toFixed(2)} → ahorrás $${saving.toFixed(2)}` : '',
    psdealsUrl ? `🔗 [Ver en PSDeals](${psdealsUrl})` : '',
  ].filter(Boolean).join('\n');

  const db = getDb();

  // Email
  const transport = getTransport();
  if (transport) {
    const to = getSetting('alert_email_to') || process.env.ALERT_EMAIL_TO;
    if (to) {
      try {
        await transport.sendMail({
          from: getSetting('smtp_user') || process.env.SMTP_USER,
          to,
          subject: `🎮 Epicodes — ${gameName} bajó a $${newPrice.toFixed(2)}`,
          text: msg.replace(/\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
          html: `<pre style="font-family:sans-serif">${msg.replace(/\*/g, '<b>').replace(/\n/g, '<br>')}</pre>`,
        });
        db.prepare(
          'INSERT INTO alert_history (watchlist_id, game_name, old_price, new_price, channel, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(watchlistId, gameName, oldPrice, newPrice, 'email', new Date().toISOString());
      } catch (err) {
        console.error('Email alert error:', err.message);
      }
    }
  }

  // Telegram
  const bot = getTelegramBot();
  const chatId = getTelegramChatId();
  if (bot && chatId) {
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      db.prepare(
        'INSERT INTO alert_history (watchlist_id, game_name, old_price, new_price, channel, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(watchlistId, gameName, oldPrice, newPrice, 'telegram', new Date().toISOString());
    } catch (err) {
      console.error('Telegram alert error:', err.message);
    }
  }
}

module.exports = { sendAlert };
