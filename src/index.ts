/**
 * HANDLER env var routing.
 *
 * Dit is de entry point van de Lambda: esbuild bundelt het naar dist/index.js
 * en de Docker CMD `index.handler` wijst hierheen. Elke Lambda-functie zet
 * HANDLER in zijn eigen configuratie; dit bestand re-exporteert de bijbehorende
 * handler. dispatcher/handler.ts en verifier/handler.ts worden daarnaast als
 * losse bundels gebouwd.
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
