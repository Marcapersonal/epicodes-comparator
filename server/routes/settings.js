const express = require('express');
const router  = express.Router();
const { getSetting, setSetting, getGiftCardRate, getArsToUsd, getAltRegion } = require('../db/database');

const VALID_REGIONS = ['AR', 'BR', 'IN', 'MX', 'TR'];

router.get('/', (_req, res) => {
  res.json({
    gift_card_rate: getGiftCardRate(),
    ars_to_usd:     getArsToUsd(),
    alt_region:     getAltRegion(),
    smtp_user:      getSetting('smtp_user')      || '',
    alert_email_to: getSetting('alert_email_to') || '',
    telegram_chat:  getSetting('telegram_chat')  || '',
  });
});

router.put('/', (req, res) => {
  const { gift_card_rate, ars_to_usd, alt_region, smtp_host, smtp_port, smtp_user, smtp_pass, alert_email_to, telegram_chat } = req.body;

  if (gift_card_rate !== undefined) {
    const rate = parseFloat(gift_card_rate);
    if (isNaN(rate) || rate <= 0 || rate > 2) return res.status(400).json({ error: 'Tasa inválida (debe ser > 0 y ≤ 2)' });
    setSetting('gift_card_rate', rate);
  }
  if (ars_to_usd !== undefined) {
    const r = parseFloat(ars_to_usd);
    if (!isNaN(r) && r > 0) setSetting('ars_to_usd', r);
  }
  if (alt_region !== undefined) {
    const reg = String(alt_region).toUpperCase();
    if (!VALID_REGIONS.includes(reg)) return res.status(400).json({ error: `Región inválida. Válidas: ${VALID_REGIONS.join(', ')}` });
    setSetting('alt_region', reg);
  }
  if (smtp_host)       setSetting('smtp_host',      smtp_host);
  if (smtp_port)       setSetting('smtp_port',      smtp_port);
  if (smtp_user)       setSetting('smtp_user',      smtp_user);
  if (smtp_pass)       setSetting('smtp_pass',      smtp_pass);
  if (alert_email_to)  setSetting('alert_email_to', alert_email_to);
  if (telegram_chat)   setSetting('telegram_chat',  telegram_chat);

  res.json({
    gift_card_rate: getGiftCardRate(),
    ars_to_usd:     getArsToUsd(),
    alt_region:     getAltRegion(),
  });
});

module.exports = router;
