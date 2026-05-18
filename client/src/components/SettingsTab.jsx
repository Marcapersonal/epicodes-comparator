import { useState, useEffect } from 'react';
import { api } from '../api.js';

const REGIONS = [
  { value: 'AR', label: 'Argentina (es-ar)' },
  { value: 'BR', label: 'Brasil (pt-br)' },
  { value: 'IN', label: 'India (en-in)' },
  { value: 'MX', label: 'México (es-mx)' },
  { value: 'TR', label: 'Turquía (en-tr)' },
];

export default function SettingsTab({ giftCardRate, onRateChange, altRegion, onAltRegionChange, showToast }) {
  const [form, setForm] = useState({
    gift_card_rate: String(giftCardRate),
    ars_to_usd:     '1200',
    alt_region:     altRegion || 'AR',
    smtp_host:      '',
    smtp_port:      '587',
    smtp_user:      '',
    smtp_pass:      '',
    alert_email_to: '',
    telegram_chat:  '',
  });
  const [saving, setSaving] = useState(false);
  const [reSearching, setReSearching] = useState(false);

  useEffect(() => {
    api.getSettings().then(s => {
      setForm(prev => ({
        ...prev,
        gift_card_rate: String(s.gift_card_rate || 0.72),
        ars_to_usd:     String(s.ars_to_usd     || 1200),
        alt_region:     s.alt_region            || 'AR',
        smtp_user:      s.smtp_user             || '',
        alert_email_to: s.alert_email_to        || '',
        telegram_chat:  s.telegram_chat         || '',
      }));
    }).catch(() => {});
  }, []); // eslint-disable-line

  function field(key) {
    return { value: form[key], onChange: e => setForm(prev => ({ ...prev, [key]: e.target.value })) };
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.saveSettings(form);
      onRateChange(parseFloat(res.gift_card_rate));
      if (res.alt_region && onAltRegionChange) onAltRegionChange(res.alt_region);
      showToast?.('✅ Configuración guardada');
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleReSearchAltRegion() {
    setReSearching(true);
    try {
      await api.reSearchAltRegion();
      showToast?.(`🔄 Buscando links de región ${form.alt_region} en background...`);
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    } finally {
      setTimeout(() => setReSearching(false), 3000);
    }
  }

  const rate = parseFloat(form.gift_card_rate) || 0;

  return (
    <form onSubmit={handleSave}>
      {/* ── Gift card rate ─────────────────────────────────────────── */}
      <div className="card settings-section">
        <div className="settings-label">💳 Tasa de Gift Card</div>
        <div style={{ marginBottom: 12 }}>
          <div className="rate-display">{rate.toFixed(2)}</div>
          <div className="rate-sublabel">USD que gastás por cada $1 de crédito en PS Store AR</div>
        </div>
        <div className="settings-field">
          <label>Tasa de gift card (USD por cada $1 de tienda)</label>
          <input className="settings-input" type="number" step="0.01" min="0.01" max="2" {...field('gift_card_rate')} />
        </div>
        <div className="settings-field">
          <label>Cotización ARS → USD (1 USD = ? ARS)</label>
          <input className="settings-input" type="number" step="1" min="1" {...field('ars_to_usd')} />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Ejemplo: si 1 USD = 1200 ARS, escribí 1200
          </div>
        </div>
      </div>

      {/* ── Región alternativa ────────────────────────────────────── */}
      <div className="card settings-section">
        <div className="settings-label">🌍 Región Alternativa de PS Store</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          Se muestra una columna extra en la tabla con el precio de esta región.
          Usá Argentina para comparar con ARS, Brasil o India para otras monedas.
        </div>
        <div className="settings-field">
          <label>Región alternativa</label>
          <select className="settings-input" {...field('alt_region')}>
            {REGIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-outline"
          onClick={handleReSearchAltRegion}
          disabled={reSearching}
          style={{ marginTop: 8 }}
          title="Busca los links de PS Store en la región seleccionada para todos los juegos del catálogo (corre en background)"
        >
          {reSearching
            ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Buscando...</>
            : `🔄 Re-buscar links de región alternativa`}
        </button>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          Nota: corre en background, puede tardar varios minutos según el tamaño del catálogo.
        </div>
      </div>

      {/* ── Email alerts ──────────────────────────────────────────── */}
      <div className="card settings-section">
        <div className="settings-label">📧 Alertas por Email (Nodemailer)</div>
        <div className="settings-field">
          <label>Servidor SMTP</label>
          <input className="settings-input" type="text" placeholder="smtp.gmail.com" {...field('smtp_host')} />
        </div>
        <div className="settings-field">
          <label>Puerto SMTP</label>
          <input className="settings-input" type="number" placeholder="587" {...field('smtp_port')} />
        </div>
        <div className="settings-field">
          <label>Usuario SMTP (tu email)</label>
          <input className="settings-input" type="email" placeholder="tu@gmail.com" {...field('smtp_user')} />
        </div>
        <div className="settings-field">
          <label>Contraseña / App Password</label>
          <input className="settings-input" type="password" placeholder="••••••••" {...field('smtp_pass')} />
        </div>
        <div className="settings-field">
          <label>Enviar alertas a (email destino)</label>
          <input className="settings-input" type="email" placeholder="alertas@gmail.com" {...field('alert_email_to')} />
        </div>
      </div>

      {/* ── Telegram ─────────────────────────────────────────────── */}
      <div className="card settings-section">
        <div className="settings-label">✈️ Alertas por Telegram</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          El token del bot se configura en el archivo <code style={{ color: 'var(--primary-h)' }}>.env</code> (TELEGRAM_BOT_TOKEN).
        </div>
        <div className="settings-field">
          <label>Chat ID de Telegram</label>
          <input className="settings-input" type="text" placeholder="987654321" {...field('telegram_chat')} />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Buscá @userinfobot en Telegram para obtener tu chat ID
          </div>
        </div>
      </div>

      <button
        className="btn btn-primary"
        type="submit"
        disabled={saving}
        style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
      >
        {saving
          ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Guardando...</>
          : '💾 Guardar configuración'}
      </button>
    </form>
  );
}
