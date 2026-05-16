const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/epicodes.db');

let db;

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  _migrate(db);
  return db;
}

function _migrate(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      game_name    TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      price_usd    REAL,
      price_raw    TEXT,
      currency     TEXT,
      discount_pct INTEGER,
      sale_end     TEXT,
      scraped_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ps_price_history_detail (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_name   TEXT NOT NULL,
      price_usd   REAL,
      date_label  TEXT,
      source      TEXT DEFAULT 'psdeals',
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      game_name     TEXT    NOT NULL,
      psdeals_url   TEXT,
      turkey_url    TEXT,
      alert_price   REAL,
      alert_enabled INTEGER DEFAULT 0,
      added_at      TEXT    NOT NULL,
      last_checked  TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER,
      game_name    TEXT NOT NULL,
      old_price    REAL,
      new_price    REAL,
      channel      TEXT,
      sent_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bulk_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id        TEXT    NOT NULL,
      game_name       TEXT    NOT NULL,
      ps_price_usd    REAL,
      ps_price_raw    TEXT,
      ps_discount_pct INTEGER,
      ps_sale_end     TEXT,
      turkey_price    REAL,
      turkey_url      TEXT,
      real_cost_usd   REAL,
      min_hist_usd    REAL,
      verdict         TEXT,
      verdict_label   TEXT,
      saving_usd      REAL,
      gift_card_rate  REAL,
      scraped_at      TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT    NOT NULL UNIQUE,
      added_at TEXT    NOT NULL,
      active   INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_bulk_batch  ON bulk_results(batch_id);
    CREATE INDEX IF NOT EXISTS idx_ph_game     ON price_history(game_name);
    CREATE INDEX IF NOT EXISTS idx_pshd_game   ON ps_price_history_detail(game_name);
    CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog(active);
  `);

  // Add new columns if they don't exist yet (safe to run on existing DBs)
  try { db.exec('ALTER TABLE bulk_results ADD COLUMN us_price_usd REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE bulk_results ADD COLUMN ps_original_price_usd REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE bulk_results ADD COLUMN ps_detail_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE bulk_results ADD COLUMN editions_json TEXT'); } catch (_) {}

  // Default settings
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('gift_card_rate', '0.72');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ars_to_usd', process.env.ARS_TO_USD || '1200');

  // Seed catalog if empty
  const catalogCount = db.prepare('SELECT COUNT(*) as c FROM catalog').get();
  if (catalogCount.c === 0) _seedCatalog(db);
}

function _seedCatalog(db) {
  const games = [
    'EA SPORTS FC 25', 'EA SPORTS FC 26', 'Grand Theft Auto V', 'Mortal Kombat 11', 'Minecraft',
    'Red Dead Redemption 2', 'F1 24', 'F1 25', 'Need for Speed Heat', 'Call of Duty: Black Ops 6',
    'Need for Speed Payback', 'Resident Evil 4', 'Resident Evil 7', 'God of War Ragnarok',
    'The Last Of Us Part I PS5', 'The Last Of Us Part I PS4', 'God of War', 'Mortal Kombat XL',
    'Battlefield 1', 'NBA 2K25', 'A Way Out', 'DRAGON BALL: Sparking! ZERO', 'Hogwarts Legacy',
    'Resident Evil 8 Village', 'It Takes Two', 'Watch Dogs 2', 'Battlefield V', 'Resident Evil 2',
    'The Last Of Us Part II PS4', 'The Last Of Us Part II PS5', 'Batman: Arkham Collection', 'Cuphead',
    'FAR CRY 5', 'STAR WARS Jedi: Fallen Order', 'Assassins Creed Origins',
    'SpiderMan: Game of the Year Edition', 'DRAGON BALL XENOVERSE 2', 'Far Cry Primal',
    'Resident Evil 3', 'The Witcher 3: Wild Hunt', 'God of War 3 Remastered', 'Mortal Kombat 1',
    'Dying Light', 'Need For Speed Rivals', 'Ark: Survival Evolved', 'Assassins Creed Valhalla',
    'Detroit: Become Human', 'SpiderMan: Miles Morales', 'Mortal Kombat X', 'Far Cry 4',
    'Metro Exodus', 'Assassins Creed Black Flag', 'Farming Simulator 22', 'Overcooked! 2',
    'The Forest', 'EA SPORTS FC 24', 'Mafia III: Definitive Edition', 'Spiderman 2', 'WWE 2K24',
    'Watch Dogs: Legion', 'Call of Duty: Black Ops Cold War', 'Crash Bandicoot 4',
    'STAR WARS Jedi: Survivor', 'The Crew Motorfest',
    'UNCHARTED: A Thief\'s End and The Lost Legacy', 'Bloodborne',
    'Cuphead & The Delicious Last Course', 'ELDEN RING', 'Far Cry 6', 'UFC 5', 'Among Us',
    'Call of Duty: Black Ops III: Zombies Chronicles', 'Gran Turismo 7',
    'Jurassic World Evolution 2', 'The Witcher 3: Wild Hunt - Complete Edition',
    'Uncharted: The Nathan Drake Collection', 'Assassins Creed Odyssey', 'Black Myth: Wukong',
    'DRAGON BALL FIGHTERZ', 'Mafia: Definitive Edition', 'The Elder Scrolls V: Skyrim', 'Astro bot',
    'DRAGON BALL Z: KAKAROT', 'Dead Island 2', 'Forza Horizon 5',
    'Ghost of Tsushima DIRECTOR\'S CUT', 'Hollow Knight Voidheart Edition',
    'Marvel\'s Guardians of the Galaxy', 'Outlast 2', 'Spiderman Remastered PS5', 'Stardew Valley',
    'Crash Bandicoot N.Sane Trilogy', 'Days Gone', 'Far Cry New Dawn',
    'LEGO Star Wars: The Skywalker Saga', 'NARUTO SHIPPUDEN: Ultimate Ninja STORM 4',
    'theHunter: Call of the Wild', 'Assassins Creed Mirage', 'Back 4 Blood',
    'Crash Team Racing Nitro-Fueled', 'Cyberpunk 2077', 'DOOM', 'Mafia II: Definitive Edition',
    'Outlast', 'South Park: La Vara de la Verdad', 'The Evil Within', 'UFC 4',
    'Assassins Creed Triple Pack: Black Flag Unity Syndicate', 'Battlefield 2042',
    'Call of Duty: Modern Warfare III', 'DOOM Eternal', 'Dead by Daylight', 'Diablo IV',
    'Farming Simulator 25', 'Grand Theft Auto: The Trilogy', 'Hades', 'Horizon Forbidden West',
    'Mx vs Atv Legends', 'No Man\'s Sky', 'Persona 5 Royal', 'SONIC X SHADOW GENERATIONS',
    'South Park: The Fractured but Whole', 'Subnautica: Below Zero', 'Tekken 7',
    'The Evil Within 2', 'UNCHARTED: Legacy of Thieves', 'Yakuza: Like a Dragon',
    'inFAMOUS Second Son', 'Alan Wake 2', 'Call of Duty: Modern Warfare II', 'DARK SOULS III',
    'DayZ', 'Dead Space', 'Dying Light 2: Stay Human', 'F1 23', 'FINAL FANTASY VIII Remastered',
    'Tom Clancy\'s Ghost Recon Breakpoint', 'Grounded', 'HITMAN World of Assassination',
    'Horizon Zero Dawn: Complete Edition', 'METAL GEAR SOLID V: THE PHANTOM PAIN',
    'Monster Hunter Rise', 'NARUTO TO BORUTO: SHINOBI STRIKER', 'Red Dead Redemption',
    'STAR WARS Battlefront 2', 'Sekiro: Shadows Die Twice', 'WWE 2K25', 'Wolfenstein II',
    'Jurassic World Evolution', 'L.A. NOIRE', 'Little Nightmares II',
    'NARUTO SHIPPUDEN: Ultimate Ninja STORM Legacy', 'Stray', 'The Crew 2', 'DARK SOULS II',
    'Ratchet & Clank: Rift Apart', 'Prince of Persia: The Lost Crown', 'Wo Long: Fallen Dynasty',
    'DEATHLOOP', 'SONIC SUPERSTARS', 'Psychonauts 2', 'SnowRunner',
    'Kingdom Come: Deliverance', 'METAL GEAR SOLID 3: Snake Eater Master Collection',
    'Kingdom Come: Deliverance II', 'Persona 5', 'Overcooked! All You Can Eat',
    'NARUTO X BORUTO Ultimate Ninja STORM CONNECTIONS', 'Sniper Elite 4', 'Returnal',
    'Baldur\'s Gate 3', 'Sniper Elite: Resistance', 'Lies of P', 'Star Wars Outlaws',
    'ARK Survival Ascended', 'Life is Strange True Colors', 'Sifu',
    'Tom Clancy\'s Rainbow Six Siege', 'Human Fall Flat', 'Metaphor: ReFantazio',
    'ELDEN RING NIGHTREIGN', 'Street Fighter 6', 'Assassins Creed Shadows', 'DOOM: The Dark Ages',
    'Persona 3 Reload', 'Ready or Not', 'Like a Dragon: Infinite Wealth', 'Mafia: Trilogy',
    'Five Nights at Freddy\'s: Help Wanted', 'TopSpin 2K25', 'Sniper Elite 5', 'Subnautica',
    'Split Fiction', 'Ratchet & Clank', 'Remnant: From the Ashes', 'Remnant II',
    'The Elder Scrolls IV: Oblivion Remastered', 'Control: Ultimate Edition', 'Raft',
    'Monster Hunter Wilds', 'Hollow Knight Silksong', 'NBA 2k26', 'Moving Out 2',
    'Goat Simulator 3', 'Hot Wheels Unleashed 2', 'Hot Wheels Unleashed',
    'Sackboy: La Gran Aventura', 'Ride 5', 'Alien Isolation', 'WRC 9 FIA World Rally Championship',
    'Ghost of Yotei', 'SAND LAND Deluxe Edition', 'Ghostrunner', 'Battlefield 6',
    'PS Plus Essential 1 mes', 'PS Plus Essential 3 meses', 'PS Plus Essential 12 meses',
    'PS Plus Extra 1 mes', 'PS Plus Extra 3 meses', 'PS Plus Extra 12 meses',
    'PS Plus Deluxe 1 mes', 'PS Plus Deluxe 3 meses', 'PS Plus Deluxe 12 meses',
    'Call of Duty: Modern Warfare', 'Gang Beasts', 'Call of Duty: Black Ops 7', 'Silent Hill 2',
    'Silent Hill F', 'Death Stranding', 'Death Stranding 2', 'Expedition 33',
    'Indiana Jones and the Great Circle', 'Helldivers 2', 'Arc Raiders', 'Rise of the Ronin',
    'Borderlands 4', 'METAL GEAR SOLID Delta: SNAKE EATER', 'Mafia: The Old Country',
    'The Outer Worlds 2', 'Days Gone Remastered', 'Mortal Kombat Legacy Kollection',
    'Call of Duty: Black Ops 4', 'Jak and Daxter: The Precursor Legacy', 'Dying Light: The Beast',
    'Jurassic World Evolution 3', 'ONE PIECE ODYSSEY', 'ONE PIECE PIRATE WARRIOR 3',
    'ONE PIECE PIRATE WARRIOR 4', 'Tom Clancy\'s Ghost Recon Wildlands',
    'Avatar: Frontiers of Pandora', 'Flight Simulator 2024', 'Steep', 'DELTARUNE', 'TEKKEN 8',
    'Party Animals', 'KINGDOM HEARTS III', 'Slime Rancher', 'Slime Rancher 2', 'Fallout 4',
    'DEATH NOTE Killer Within', 'THE KING OF FIGHTERS XV', 'Aliens: Fireteam Elite', 'Undisputed',
    'The Quarry', 'MY HERO ACADEMIA: All\'s Justice', 'Resident Evil Requiem',
    'Need for Speed Unbound', 'Resident Evil 5', 'Resident Evil 6',
    'Five Nights at Freddy\'s: Secret of the Mimic', 'Terraria', 'Phasmophobia',
    'La Tierra Media: Sombras de Mordor', 'Five Nights at Freddy\'s: Security Breach',
    'The Warriors', 'Far Cry 3', 'WRC 10 FIA World Rally Championship',
    'LEGO Marvel Super Heroes', 'SHADOW OF THE COLOSSUS', 'Wobbly Life',
    'LEGO Marvel Super Heroes 2', 'Twisted Metal: Black', 'A Plague Tale: Requiem',
    'METAL GEAR SOLID: MASTER COLLECTION Vol.1', 'Gears of War: Reloaded', 'Riders Republic',
    'Nioh 3', 'Call of Duty: Vanguard', 'Need for Speed Hot Pursuit',
    'Devil May Cry 5 + Vergil', 'Batman: Arkham Knight', 'Crisol: Theater of Idols', 'REANIMAL',
    'Horizon Zero Dawn Remastered', 'Goat Simulator', 'Goat Simulator Remastered',
    'God of War Sons of Sparta', 'CODE VEIN II', 'TIEBREAK', 'Contraband Police', 'PAYDAY 3',
    'PAYDAY 2', 'RIDE 6', 'Legacy of Kain Soul Reaver 1&2 Remastered', 'RoadCraft',
    'Assetto Corsa', 'Assetto Corsa Competizione', 'Overcooked! + Overcooked! 2',
    'LEGO CITY Undercover', 'Watch Dogs 1 + Watch Dogs 2', 'Cronos: The New Dawn',
    'FINAL FANTASY VII REBIRTH', 'MADiSON', 'We Happy Few', 'Rust', 'Hell Let Loose',
    'Little Nightmares', 'Little Nightmares III', 'Poppy Playtime Chapter 1',
    'Poppy Playtime Chapter 2', 'Poppy Playtime Chapter 3', 'Poppy Playtime Chapter 4',
    'Crimson Desert', 'Age of Empires II: Definitive Edition', 'Green Hell', 'Borderlands 3',
    'Demon Slayer The Hinokami Chronicles', 'Demon Slayer The Hinokami Chronicles 2',
    'RESIDENT EVIL 2 Deluxe Edition', 'Resident Evil 4 Gold Edition',
    'Resident Evil Village Gold Edition', 'Resident Evil Requiem Deluxe Edition',
    'DRAGON BALL Z: KAKAROT DAIMA EDITION', 'ASTRONEER', 'DRAGON BALL XENOVERSE 2 Deluxe Edition',
    'Hello Neighbor 2', '7 Days to Die', 'TRAIL OUT',
    'It Takes Two + A Way Out Hazelight Bundle', 'Hellblade: Senua\'s Sacrifice',
    'Senua\'s Saga: Hellblade II', 'Marathon', 'FINAL FANTASY VII REMAKE',
    'Sonic Racing CrossWorlds', 'MLB The Show 26', 'Jujutsu Kaisen Cursed Clash',
    'NieR Automata Game of the YoRHa Edition',
    'Teenage Mutant Ninja Turtles: The Cowabunga Collection',
    'Brothers: a Tale of two Sons', 'Brothers: A Tale of Two Sons Remake', 'Serious Sam 4',
    'WWE 2K26', 'Sniper Ghost Warrior Contracts 2', 'Plants vs. Zombies Replanted',
    'Stellar Blade', 'Mortal Kombat 1: Definitive Edition', 'Warhammer 40000 Space Marine 2',
    'Mortal Kombat 11 Ultimate', 'Life is Strange Reunion', 'Injustice 2', 'RIDE 4', 'Avowed',
    'FINAL FANTASY XVI', 'Tony Hawks Pro Skater 3 + 4', 'LEGO NINJAGO',
    'Five Nights at Freddy\'s', 'Five Nights at Freddy\'s 2', 'Five Nights at Freddy\'s 3',
    'Five Nights at Freddy\'s 4', 'Five Nights at Freddy\'s: Help Wanted 2', 'PRAGMATA',
    'STALKER 2 Heart of Chornobyl', 'Valentino Rossi The Game', 'Sonic Frontiers',
    'Resident Evil 4 (2005)', 'Tour de France 2025', 'Sonic Origins', 'MotoGP 26', 'Starfield',
    'Minecraft Dungeons', 'SAROS', 'MOTORSLICE', 'Directiva 8020', 'MotoGP 21',
  ];

  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO catalog (name, added_at) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const name of games) ins.run(name, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getGiftCardRate() { return parseFloat(getSetting('gift_card_rate') || '0.72'); }
function getArsToUsd()     { return parseFloat(getSetting('ars_to_usd')     || process.env.ARS_TO_USD || '1200'); }

function recordPrice(gameName, source, priceUsd, opts = {}) {
  getDb().prepare(`
    INSERT INTO price_history (game_name, source, price_usd, price_raw, currency, discount_pct, sale_end, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gameName, source, priceUsd, opts.raw || null, opts.currency || 'USD',
         opts.discount || null, opts.saleEnd || null, new Date().toISOString());
}

function getMinHistoricalPrice(gameName) {
  const row = getDb().prepare(
    "SELECT MIN(price_usd) as min FROM price_history WHERE game_name = ? AND source = 'psdeals' AND price_usd IS NOT NULL"
  ).get(gameName);
  return row?.min ?? null;
}

function getPriceDetailHistory(gameName) {
  return getDb().prepare(
    'SELECT price_usd, date_label, recorded_at FROM ps_price_history_detail WHERE game_name = ? ORDER BY recorded_at ASC'
  ).all(gameName);
}

function savePriceDetailHistory(gameName, points) {
  const db  = getDb();
  const ins = db.prepare('INSERT INTO ps_price_history_detail (game_name, price_usd, date_label, recorded_at) VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const p of points) ins.run(gameName, p.price, p.date, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function detectSaleDates(gameName) {
  return getDb().prepare(
    "SELECT scraped_at, price_usd FROM price_history WHERE game_name = ? AND source = 'psdeals' AND discount_pct > 0 ORDER BY scraped_at ASC"
  ).all(gameName).map(r => ({ date: r.scraped_at.slice(0, 10), price: r.price_usd }));
}

// ── Catalog ───────────────────────────────────────────────────────────────────

function getCatalog() {
  return getDb().prepare('SELECT * FROM catalog WHERE active=1 ORDER BY name ASC').all();
}

function addToCatalog(name) {
  const db = getDb();
  const ex = db.prepare('SELECT id,active FROM catalog WHERE name=? COLLATE NOCASE').get(name.trim());
  if (ex) {
    db.prepare('UPDATE catalog SET active=1 WHERE id=?').run(ex.id);
    return { id: ex.id, created: false };
  }
  const r = db.prepare('INSERT INTO catalog (name,added_at) VALUES (?,?)').run(name.trim(), new Date().toISOString());
  return { id: r.lastInsertRowid, created: true };
}

function removeFromCatalog(id) {
  getDb().prepare('UPDATE catalog SET active=0 WHERE id=?').run(id);
}

module.exports = { getDb, getSetting, setSetting, getGiftCardRate, getArsToUsd, recordPrice, getMinHistoricalPrice, getPriceDetailHistory, savePriceDetailHistory, detectSaleDates, getCatalog, addToCatalog, removeFromCatalog };
