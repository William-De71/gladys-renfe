import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities,
  plainText,
  titleOf,
  linkOf,
  alertState,
  messageOf,
  parseTraffic,
  messageAt,
  lineTraffic,
  seriousMessages,
} from '../src/traffic.js';
import { readAlerts } from '../src/realtime.js';
import { ALERTS, NOW, alertC3, feedOf, fixtureNetwork } from './helpers/fixtures.js';

const HOUR = 3600;
const now = NOW / 1000;
const { lines } = await fixtureNetwork();
const lineOfRoute = (id) => lines.find((line) => line.routeIds.includes(id)) ?? null;
const raw = (fields) => readAlerts(feedOf([alertC3(fields)])).alerts[0];

test('texts: plain, the tags and the Basque dropped, a title', () => {
  assert.equal(plainText(' Línea C4 <br/>con retrasos\r\n\n  hoy '), 'Línea C4\ncon retrasos\nhoy');
  assert.equal(plainText('#MadC5 Por obras.'), 'Por obras.');
  assert.equal(
    plainText(
      'AMURRIO. 1. trenbideko igogailua zerbitzuz kanpo daude. // AMURRIO. Ascensor de vía 1 se encuentra fuera de servicio. ',
    ),
    'AMURRIO. Ascensor de vía 1 se encuentra fuera de servicio.',
  );
  assert.equal(decodeEntities('&nbsp;&amp;&ntilde;&#233;&unknown;'), ' &ñé&unknown;');
  assert.equal(titleOf('', 'La línea C6 está cortada. Los trenes…'), 'La línea C6 está cortada.');
  // A heading alone says too little: the next sentence joins it.
  assert.equal(
    titleOf('', 'Línea C1. Tren con salida prevista a las 20:50h, hoy no circula.'),
    'Línea C1. Tren con salida prevista a las 20:50h, hoy no circula.',
  );
  assert.equal(
    titleOf('', 'ATENCIÓN Línea C3:\nPor obras de mejora en la infraestructura.'),
    'ATENCIÓN Línea C3: Por obras de mejora en la infraestructura.',
  );
  assert.equal(titleOf('Cabecera', 'Texto.'), 'Cabecera');
  assert.equal(titleOf('', 'x'.repeat(200)).length, 140);
  assert.equal(linkOf('https://www.renfe.com/a b'), 'https://www.renfe.com/a%20b');
  assert.equal(linkOf('http://insecure.es'), '');
});

test('the weight of an alert: its effect, its severity, else its Spanish words', () => {
  const state = (fields, text = '') =>
    alertState({ effect: null, severity: null, ...fields }, text);
  assert.equal(state({ effect: 'NO_SERVICE' }), 'major');
  assert.equal(state({ effect: 'DETOUR' }), 'disrupted');
  assert.equal(state({ effect: 'ADDITIONAL_SERVICE' }), 'info');
  assert.equal(state({ severity: 'SEVERE' }), 'major');
  assert.equal(
    state({}, 'Se encuentra suspendido el servicio de trenes entre Sol y Atocha.'),
    'major',
  );
  assert.equal(state({}, 'SERVICIO POR AUTOBÚS C-5'), 'major');
  assert.equal(state({}, 'Sin servicio ferroviario por obras.'), 'major');
  assert.equal(state({}, 'Los trenes circulan con frecuencias de paso modificadas.'), 'disrupted');
  assert.equal(state({}, 'Con motivo de la huelga convocada para hoy…'), 'disrupted');
  assert.equal(state({}, 'Los trenes sufren demoras de 10-20 minutos.'), 'disrupted');
  // One train cancelled is no interruption of the line.
  assert.equal(
    state({}, 'Línea RAM. Tren con salida prevista a las 22:30h, hoy no circula.'),
    'disrupted',
  );
  // A lift out of order is an information.
  assert.equal(
    state({}, 'Ascensor de vía 2 se encuentra fuera de servicio, servicio suspendido.'),
    'info',
  );
  assert.equal(state({}, 'Son válidos los títulos de viaje de Cercanías.'), 'info');
});

test('the real alerts of Renfe: lines gathered, stations left out, titles', () => {
  const traffic = parseTraffic(readAlerts(ALERTS), { lineOfRoute });
  assert.ok(traffic.messages.every((message) => message.lineIds.length > 0));
  // The alert of a lift at Nuevos Ministerios names a station only.
  assert.ok(!traffic.messages.some((message) => message.id === 'INFO_526407'));
  const c5 = traffic.messages.find((message) => message.id === 'AVISO_525129');
  assert.deepEqual(c5.lineIds, ['10-c5']);
  assert.equal(c5.state, 'disrupted');
  assert.match(c5.title, /^Por obras de mejora en la infraestructura, los días 14, 15, 21 y 22/);
  assert.deepEqual(c5.periods, [{ start: 1794219780000, end: null }]);
  // The strike of the day, on every line of Madrid.
  const strike = traffic.messages.find((message) => message.id === 'AVISO_526684');
  assert.ok(strike.lineIds.includes('10-c3') && strike.lineIds.includes('10-c10'));
  assert.equal(strike.state, 'disrupted');
  const c3 = lineTraffic(traffic, '10-c3', NOW);
  assert.equal(c3.state, 'disrupted');
  assert.equal(lineTraffic(traffic, 'ld-ave', NOW).state, 'normal');
  // San Sebastián: the Spanish half of a bilingual alert.
  const weather = traffic.messages.find((message) => message.id === 'AVISO_526356');
  assert.match(weather.title, /^Debido a condiciones atmosféricas adversas/);
});

test('each line once, though the routes of both directions name it', () => {
  const message = messageOf(
    raw({ routeIds: ['10T0007C3', '10T0008C3', '10T0001C1'] }),
    lineOfRoute,
  );
  assert.deepEqual(message.lineIds, ['10-c3', '10-c1']);
  assert.deepEqual(parseTraffic({ alerts: [raw({ routeIds: [] })] }, { lineOfRoute }).messages, []);
});

test('periods: under way, coming, over; the state of a line', () => {
  const base = messageOf(raw(), lineOfRoute);
  assert.equal(messageAt(base, NOW).coming, false);
  assert.equal(messageAt({ ...base, periods: [] }, NOW).start, null);
  assert.equal(
    messageAt(
      { ...base, periods: [{ start: (now - 5 * HOUR) * 1000, end: (now - HOUR) * 1000 }] },
      NOW,
    ),
    null,
  );
  const traffic = parseTraffic(
    readAlerts(
      feedOf([
        alertC3({ id: 'late' }),
        alertC3({
          id: 'cut',
          text: 'Servicio interrumpido entre Pinto y Aranjuez.',
          periods: [{ start: String(now - 600) }],
        }),
        alertC3({
          id: 'soon',
          text: 'Refuerzo de trenes por el concierto.',
          periods: [{ start: String(now + 24 * HOUR), end: String(now + 28 * HOUR) }],
        }),
        alertC3({ id: 'later', periods: [{ start: String(now + 5 * 24 * HOUR) }] }),
      ]),
    ),
    { lineOfRoute },
  );
  const line = lineTraffic(traffic, '10-c3', NOW);
  assert.equal(line.state, 'major');
  assert.equal(line.since, NOW - 600000);
  assert.deepEqual(
    line.messages.map((m) => m.id),
    ['cut', 'late'],
  );
  assert.deepEqual(
    line.upcoming.map((m) => m.id),
    ['soon'],
  );
  assert.equal(seriousMessages(line).length, 2);
  assert.equal(lineTraffic(traffic, '10-c4a', NOW).state, 'normal');
  assert.equal(lineTraffic(null, '10-c3', NOW).state, 'unknown');
});
