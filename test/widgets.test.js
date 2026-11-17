// The widget contents pass the validator of the SDK (what the core would
// drop or truncate), in every language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import {
  buildDeparturesWidget,
  buildTrafficWidget,
  messageContent,
  readCount,
  routeValue,
  shortDate,
  dateText,
  BOARD_COUNT,
} from '../src/widgets.js';
import { parseTraffic, lineTraffic } from '../src/traffic.js';
import { readAlerts } from '../src/realtime.js';
import { LANGUAGES } from '../src/i18n.js';
import { NOW, TZ, passage, alertC3, feedOf, fixturePassages } from './helpers/fixtures.js';

const CHAMARTIN = await fixturePassages('17000');
const ARANJUEZ = await fixturePassages('18000', { destination: '60200' });
const line = (id, name) => ({
  id,
  name,
  network: 'cer',
  nucleo: id.slice(0, 2),
  nucleoName: 'Madrid',
});

/**
 * @description Assert that the core would keep the content whole.
 * @param {object} content - The content.
 * @param {string} label - For the message.
 */
function assertValid(content, label) {
  assert.deepEqual(validateWidgetContent(content), [], label);
}

test('departures widget: one compact row per route, soonest first, in every language', () => {
  for (const language of LANGUAGES) {
    const content = buildDeparturesWidget({
      title: 'Madrid-Chamartín-Clara Campoamor',
      passages: CHAMARTIN,
      readAt: NOW,
      count: 6,
      language,
      now: NOW,
      timeZone: TZ,
    });
    assertValid(content, language);
    const [heading, caption, status] = content.components;
    assert.equal(heading.text, 'Madrid-Chamartín-Clara Campoamor');
    assert.match(caption.text, /^Renfe · .*22:05/);
    assert.equal(status.items.length, 6);
  }
  const es = buildDeparturesWidget({
    title: 'Chamartín',
    passages: CHAMARTIN,
    readAt: NOW,
    count: 4,
    language: 'es',
    now: NOW,
    timeZone: TZ,
  });
  assert.deepEqual(
    es.components[2].items.map((item) => [item.label, item.value, item.color]),
    [
      ['C8a → El Escorial', '2 min · 23:45', 'warning'],
      ['C3 → Aranjuez', '8 · 52 min · 23:45', 'success'],
      ['C4a → Parla', '18 · 45 min', 'warning'],
      ['C4b → Madrid-Atocha Cercanías', '25 min', 'warning'],
    ],
  );
});

test('departures widget: a cancelled train and a late one colour their row', () => {
  const passages = [
    passage({ time: '22:10', cancelled: true, trip: 'C1' }),
    passage({ time: '22:18', trip: 'C2' }),
    passage({ time: '22:08', line: 'C4a', lineId: '10-c4a', destination: 'Parla', delay: 6 }),
    passage({
      time: '22:12',
      line: 'AVE',
      lineId: 'ld-ave',
      network: 'ld',
      number: '3063',
      destination: 'Barcelona-Sants',
    }),
  ].sort((a, b) => a.at - b.at);
  const content = buildDeparturesWidget({
    title: 'Madrid-Atocha Cercanías',
    passages,
    readAt: NOW,
    count: 6,
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(content, 'troubled');
  assert.deepEqual(
    content.components[2].items.map((item) => [item.label, item.value, item.color]),
    [
      ['AVE → Barcelona-Sants', '6 min', 'success'],
      ['C4a → Parla', '8 min', 'warning'],
      ['C3 → Aranjuez', 'supprimé 22:10 · 12 min', 'warning'],
    ],
  );
});

test('departures widget: times beyond an hour, nothing announced', () => {
  const options = { language: 'en', now: NOW, timeZone: TZ };
  const late = [passage({ time: '22:12' }), passage({ time: '23:32', realtime: false })];
  assert.equal(routeValue(late, options), '6 min · 23:32');
  const empty = buildDeparturesWidget({
    title: 'Aranjuez',
    passages: [],
    readAt: NOW,
    count: 6,
    language: 'de',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(empty, 'empty');
  assert.equal(empty.components[1].text, 'Kein Zug angekündigt. Renfe · aktualisiert um 22:05.');
  assert.equal(empty.ttl_seconds, 300);
});

test('departures widget: several stations in one list, a row per station then its routes', () => {
  const content = buildDeparturesWidget({
    boards: [
      {
        title: 'Atocha → Aranjuez',
        label: 'Madrid-Atocha Cercanías',
        passages: ARANJUEZ,
        readAt: NOW,
      },
      { title: 'Aranjuez', label: 'Aranjuez', passages: [], readAt: NOW - 60000 },
    ],
    count: 6,
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(content, 'several');
  const [heading, caption, status] = content.components;
  assert.equal(heading.text, 'Madrid-Atocha Cercanías · Aranjuez');
  assert.equal(caption.text, 'Renfe');
  assert.deepEqual(
    status.items.map((item) => [item.icon ?? null, item.label, item.value]),
    [
      ['map-pin', 'Madrid-Atocha Cercanías', 'lu à 22:05'],
      [null, 'C3 → Aranjuez', '22 min · 23:12 · 23:59'],
      [null, 'Regional → Alcázar de San Juan', '07:10'],
      [null, 'Regional → Albacete-Los Llanos', '18:40'],
      [null, 'Regional → Jaén', '19:31'],
      ['map-pin', 'Aranjuez', 'Aucun train annoncé'],
    ],
  );
});

test('traffic widget: states, messages under way and coming, in every language', () => {
  const now = NOW / 1000;
  const traffic = parseTraffic(
    readAlerts(
      feedOf([
        alertC3(),
        alertC3({
          id: 'info-c4',
          routeIds: ['10T0011C4'],
          text: 'Ascensor de la estación de Sol fuera de servicio.',
        }),
        alertC3({
          id: 'works',
          routeIds: ['10T0017C5'],
          text: '#MadC5 Por obras, los trenes de la línea C5 circularán con frecuencias de paso modificadas.',
          periods: [{ start: String(now + 2 * 86400), end: String(now + 2 * 86400 + 5 * 3600) }],
        }),
      ]),
    ),
    {
      lineOfRoute: (id) => ({ id: `10-${id.slice(7).toLowerCase()}` }),
    },
  );
  const lines = [
    line('10-c3', 'C3'),
    line('10-c4', 'C4'),
    line('10-c5', 'C5'),
    line('10-c7', 'C7'),
  ].map((entry) => ({ line: entry, traffic: lineTraffic(traffic, entry.id, NOW) }));
  for (const language of LANGUAGES) {
    assertValid(
      buildTrafficWidget({ lines, readAt: NOW, language, now: NOW, timeZone: TZ }),
      language,
    );
  }
  const fr = buildTrafficWidget({ lines, readAt: NOW, language: 'fr', now: NOW, timeZone: TZ });
  const [heading, status, cards, caption] = fr.components;
  assert.equal(heading.text, 'Trafic Renfe');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value, item.color]),
    [
      ['Cercanías Madrid C3', 'Trafic perturbé', 'warning'],
      ['Cercanías Madrid C4', 'Info trafic', 'info'],
      ['Cercanías Madrid C5', 'Trafic normal', 'success'],
      ['Cercanías Madrid C7', 'Trafic normal', 'success'],
    ],
  );
  // Under way, the heaviest first, then the coming ones, with their period.
  assert.deepEqual(
    cards.items.map((item) => [item.badge.text, item.subtitle]),
    [
      ['C3', 'Perturbation · depuis 21:05'],
      ['C4', 'Information · depuis 21:05'],
      ['C5', 'À venir · 19/11 22:05 → 20/11 03:05'],
    ],
  );
  assert.match(cards.items[2].title, /^Por obras, los trenes de la línea C5/);
  assert.equal(caption.text, 'Renfe · mis à jour à 22:05');
  const calm = buildTrafficWidget({
    lines: [lines[3]],
    readAt: NOW,
    language: 'es',
    now: NOW,
    timeZone: TZ,
  });
  assertValid(calm, 'calm');
  assert.equal(
    calm.components[2].text,
    'Ningún aviso para estas líneas. Renfe · actualizado a las 22:05.',
  );
});

test('messages and settings', () => {
  assertValid(messageContent('Hola'), 'message');
  assert.equal(readCount(undefined, BOARD_COUNT), BOARD_COUNT.default);
  assert.equal(readCount('99', BOARD_COUNT), BOARD_COUNT.max);
  assert.equal(readCount(0, BOARD_COUNT), BOARD_COUNT.min);
  assert.equal(shortDate(Date.parse('2026-12-31T22:59:00Z'), TZ), '31/12');
  assert.equal(shortDate(null, TZ), '');
  assert.equal(dateText(Date.parse('2026-11-17T22:01:00Z'), NOW, TZ), '23:01');
  assert.equal(dateText(Date.parse('2026-11-16T20:31:00Z'), NOW, TZ), '16/11 21:31');
  assert.equal(dateText(null, NOW, TZ), '');
});
