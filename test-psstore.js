// Diagnostic script — tests PS Store scraper directly
// The scraper exports searchPsStoreUS (not searchGame)
process.env.DB_PATH = './data/epicodes.db';
const scraper = require('./server/scrapers/psstore.js');

async function test() {
  const games = ['Alan Wake 2', 'God of War Ragnarok', 'GTA V'];
  for (const game of games) {
    console.log(`\n--- Testing: ${game} ---`);
    try {
      const result = await scraper.searchPsStoreUS(game);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('ERROR:', err.message);
      console.error('Stack:', err.stack);
    }
  }
}
test();
