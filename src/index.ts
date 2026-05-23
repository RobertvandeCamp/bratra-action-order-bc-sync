/**
 * HANDLER env var routing.
 *
 * Dit bestand is NIET een esbuild entry point (die zijn dispatcher/handler.ts
 * en verifier/handler.ts). Het is een convenience re-export voor het geval
 * een enkele Dockerfile CMD naar index.handler wijst.
 */

const HANDLER = process.env.HANDLER;

if (HANDLER === 'dispatcher') {
  module.exports = require('./dispatcher/handler');
} else if (HANDLER === 'verifier') {
  module.exports = require('./verifier/handler');
} else {
  throw new Error(
    `Ongeldige HANDLER env var: "${HANDLER}". Geldige waarden: "dispatcher", "verifier".`
  );
}
