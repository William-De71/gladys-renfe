// The whole integration against the fake Gladys of the SDK
// (`@gladysassistant/integration-sdk/testing`), which checks the discovered
// devices, the states and the scene events like the host API does, and a
// fake Renfe serving real (reduced) open data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { createApp, SCENE_ACTIONS, ACTIONS, IDLE_INTERVAL_MS } from '../src/app.js';
import { BUSY_RETRIES, ENDPOINTS } from '../src/renfe-api.js';
import { WIDGETS } from '../src/widgets.js';
import { TRIGGERS } from '../src/events.js';
import { formatTime } from '../src/time.js';
import {
  fakeRenfe,
  storePath,
  silent,
  feedOf,
  tripUpdate,
  alertC3,
  NOW,
  TZ,
} from './helpers/fixtures.js';

const CONFIG = {
  station_1: 'Madrid-Atocha Cercanías',
  station_1_destination: 'Aranjuez',
  station_2: 'chamartin',
  station_3: 'Nulle part',
  lines: 'C3, C4a, C9 Bilbao',
  interval: '60',
  language: 'fr',
};
const PREFIX = 'ext:test-integration';
const ATOCHA = `${PREFIX}:station:18000_60200`;
const CHAMARTIN = `${PREFIX}:station:17000`;
const C3 = `${PREFIX}:line:10-c3`;
const C4A = `${PREFIX}:line:10-c4a`;
const QUIET = feedOf([]);
const MINUTE = 60 * 1000;

/**
 * @description The integration, connected to a fake Gladys and a fake Renfe.
 * @param {object} [options] - `{ config, path, logger, alerts }`: `alerts`
 * the feed of alerts served from the start (the real one by default, the
 * evening of the strike).
 * @returns {Promise<object>} `{ gladys, app, api, clock, path, pauses }`.
 */
async function startApp({ config = CONFIG, path = storePath(), logger = silent, alerts } = {}) {
  const clock = { now: NOW };
  const api = fakeRenfe();
  if (alerts) {
    api.state.feeds['alerts.json'] = alerts;
  }
  const pauses = [];
  const gladys = createFakeGladys({ config });
  const app = createApp(gladys, {
    fetch: api,
    storePath: path,
    now: () => clock.now,
    timeZone: TZ,
    timers: false,
    logger,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  await gladys.connect();
  await app.whenReady();
  return { gladys, app, api, clock, path, pauses };
}

const created = async (gladys, externalId) => {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  assert.ok(device, `${externalId} is offered`);
  await gladys.fake.deviceCreated(device);
  return device;
};
const eventsOf = (gladys, key) => gladys.fake.sceneEvents.filter((event) => event.key === key);
const cercaniasReads = (app) => app.api.requests.byEndpoint[ENDPOINTS.TRIP_UPDATES_CER] ?? 0;
const tripOf = (passage) => passage.trip.split('@')[0];

test('two stations and two lines become four devices; unknown names are reported', async (t) => {
  const { gladys, api } = await startApp();
  t.after(() => gladys.fake.shutdown());
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((device) => [device.external_id, device.name]),
    [
      [ATOCHA, 'Renfe Madrid-Atocha Cercanías → Aranjuez'],
      [CHAMARTIN, 'Renfe Madrid-Chamartín-Clara Campoamor'],
      [C3, 'Renfe Cercanías Madrid C3'],
      [C4A, 'Renfe Cercanías Madrid C4a'],
    ],
  );
  const status = gladys.fake.connectionStatus;
  assert.equal(status.connected, true);
  assert.equal(
    status.message.fr,
    'Connecté à Renfe : 2 gare(s), 2 ligne(s), temps réel lu toutes les 60 s. Inconnu ou ambigu : Nulle part, C9 Bilbao.',
  );
  // The two zips once, the real time of both networks in one request each,
  // the tracks, the alerts.
  assert.deepEqual(
    api.calls.map((call) => `${call.method} ${call.path}`),
    [
      'GET google_transit.zip',
      'GET fomento_transit.zip',
      'GET trip_updates_LD.json',
      'GET trip_updates.json',
      'GET vehicle_positions.json',
      'GET alerts.json',
    ],
  );
  // The first readings are a baseline: nothing fires.
  assert.deepEqual(gladys.fake.sceneEvents, []);
});

test('created devices get their states, sent again after the creation', async (t) => {
  const { gladys, app, api, clock } = await startApp();
  t.after(() => gladys.fake.shutdown());
  await created(gladys, ATOCHA);
  await created(gladys, CHAMARTIN);
  await created(gladys, C3);
  const [next] = app.getSnapshot('18000_60200').passages;
  assert.equal(next.destination, 'Aranjuez');
  assert.equal(gladys.fake.lastState(`${ATOCHA}:wait`), 22);
  assert.equal(gladys.fake.lastState(`${ATOCHA}:next`), 'C3 → Aranjuez · 22 min · arr. 23:13');
  assert.equal(gladys.fake.lastState(`${ATOCHA}:delay`), 0);
  assert.equal(
    gladys.fake.lastState(`${CHAMARTIN}:next`),
    'C8a → El Escorial · 2 min (+21 min de retard) · voie 11',
  );
  // The strike of the day on every line of Madrid.
  assert.match(gladys.fake.lastState(`${C3}:status`), /^Trafic perturbé : Con motivo de la huelga/);
  // The train gets four minutes late; the line not created gets nothing.
  api.state.feeds['trip_updates.json'] = feedOf(
    [
      tripUpdate(tripOf(next), {
        stopId: '18000',
        time: (next.scheduled + 4 * MINUTE) / 1000,
        delay: 240,
      }),
    ],
    (NOW + MINUTE) / 1000,
  );
  clock.now += MINUTE;
  await app.readStations();
  assert.equal(gladys.fake.lastState(`${ATOCHA}:delay`), 4);
  assert.equal(
    gladys.fake.lastState(`${ATOCHA}:next`),
    'C3 → Aranjuez · 25 min (+4 min de retard) · arr. 23:17',
  );
  assert.equal(gladys.fake.lastState(`${C4A}:status`), undefined);
});

test('departure soon and delays: fired close to their mark, once, between two readings too', async (t) => {
  const { gladys, app, api, clock } = await startApp({
    config: {
      station_1: 'Madrid-Atocha Cercanías',
      station_1_destination: 'Aranjuez',
      language: 'en',
    },
  });
  t.after(() => gladys.fake.shutdown());
  const passage = app.getSnapshot('18000_60200').passages[0];
  clock.now += MINUTE;
  const at = passage.scheduled + 12 * MINUTE;
  api.state.feeds['trip_updates.json'] = feedOf([
    tripUpdate(tripOf(passage), { stopId: '18000', time: at / 1000, delay: 720 }),
  ]);
  await app.readStations({ force: true });
  // 12 minutes late: the marks 5 and 10 at once.
  assert.deepEqual(
    eventsOf(gladys, TRIGGERS.DEPARTURE_DELAYED).map((event) => [
      event.data.minutes,
      event.data.delay_minutes,
      event.data.expected_time,
    ]),
    [
      ['5', 12, formatTime(at, TZ)],
      ['10', 12, formatTime(at, TZ)],
    ],
  );
  const ours = () => eventsOf(gladys, TRIGGERS.DEPARTURE_SOON);
  assert.deepEqual(ours(), []);
  // Without a reading, five minutes before: the 5-minute mark.
  clock.now = at - 5 * MINUTE + 10000;
  await app.checkReminders();
  assert.deepEqual(
    ours().map((event) => [event.data.minutes, event.data.line, event.data.destination]),
    [['5', 'C3', 'Aranjuez']],
  );
  assert.equal(ours()[0].data.station, `${PREFIX}:station:18000_60200`);
  assert.match(
    ours()[0].data.summary,
    new RegExp(`^C3 to Aranjuez leaves Madrid-Atocha Cercanías in 5 min \\(${formatTime(at, TZ)}`),
  );
  await app.checkReminders();
  await app.readStations({ force: true });
  assert.equal(ours().length, 1);
  assert.equal(eventsOf(gladys, TRIGGERS.DEPARTURE_DELAYED).length, 2);
});

test('train cancelled: fired once per train of the next two hours', async (t) => {
  const { gladys, app, api } = await startApp({
    config: { station_1: '17000', language: 'fr' },
  });
  t.after(() => gladys.fake.shutdown());
  const passage = app
    .getSnapshot('17000')
    .passages.find((entry) => entry.lineId === '10-c3' && !entry.realtime);
  api.state.feeds['trip_updates.json'] = feedOf([tripUpdate(tripOf(passage), { cancelled: true })]);
  await app.readStations({ force: true });
  await app.readStations({ force: true });
  const time = formatTime(passage.scheduled, TZ);
  const cancelled = eventsOf(gladys, TRIGGERS.DEPARTURE_CANCELLED);
  assert.deepEqual(
    cancelled.map((event) => [event.data.line, event.data.time, event.data.station]),
    [['C3', time, `${PREFIX}:station:17000`]],
  );
  assert.equal(
    cancelled[0].data.summary,
    `Le C3 de ${time} vers Aranjuez au départ de Madrid-Chamartín-Clara Campoamor est supprimé.`,
  );
  // Shown in the widget, left out of the waits.
  const widget = await gladys.fake.widgetGet(WIDGETS.DEPARTURES, { settings: {}, language: 'fr' });
  assert.ok(
    widget.data.content.components[2].items.some((item) => item.value.includes(`supprimé ${time}`)),
  );
});

test('a disruption, then back to normal: fired once each, never again after a restart', async (t) => {
  const path = storePath();
  const config = { station_1: '18000', lines: 'C3', language: 'fr' };
  const { gladys, app, api, clock } = await startApp({ config, path, alerts: QUIET });
  t.after(() => gladys.fake.shutdown());
  api.state.feeds['alerts.json'] = feedOf([alertC3()]);
  await app.trafficTick();
  assert.deepEqual(
    gladys.fake.sceneEvents.map((event) => [event.key, event.data.line_name, event.data.kind]),
    [
      [TRIGGERS.LINE_DISRUPTED, 'Cercanías Madrid C3', undefined],
      [TRIGGERS.TRAFFIC_MESSAGE, 'Cercanías Madrid C3', 'disrupted'],
    ],
  );
  const [disrupted] = gladys.fake.sceneEvents;
  assert.equal(disrupted.data.line, C3);
  assert.deepEqual([disrupted.data.state, disrupted.data.start], ['disrupted', '17/11 21:05']);
  assert.match(disrupted.data.title, /^Por una incidencia en la infraestructura/);
  await app.trafficTick();
  assert.equal(gladys.fake.sceneEvents.length, 2);
  // A restart on the same /data: nothing replayed, no zip downloaded again.
  const second = createFakeGladys({ config });
  t.after(() => second.fake.shutdown());
  const calls = api.calls.length;
  const restarted = createApp(second, {
    fetch: api,
    storePath: path,
    now: () => clock.now,
    timeZone: TZ,
    timers: false,
    logger: silent,
  });
  await second.connect();
  await restarted.whenReady();
  assert.deepEqual(second.fake.sceneEvents, []);
  assert.ok(!api.calls.slice(calls).some((call) => call.path.endsWith('.zip')));
  // The incident over; a mere information still runs.
  clock.now += 30 * MINUTE;
  api.state.feeds['alerts.json'] = feedOf([
    alertC3({ text: 'Son válidos los títulos de viaje de Cercanías en los autobuses.' }),
  ]);
  await restarted.trafficTick();
  assert.deepEqual(
    second.fake.sceneEvents.map((event) => [event.key, event.data.state]),
    [[TRIGGERS.LINE_RESTORED, 'info']],
  );
});

test('one request per network for every station; quiet stations every 10 minutes', async (t) => {
  const { gladys, app, clock } = await startApp({
    config: {
      station_1: '17000',
      station_2: '17000',
      station_2_line: 'C3',
      interval: '30',
      added_stations: [
        { station: '18000', destination: '60200', line: '' },
        { station: '18000', destination: '', line: '10-c4a' },
      ],
    },
  });
  t.after(() => gladys.fake.shutdown());
  assert.equal(app.getStations().length, 4);
  const before = cercaniasReads(app);
  clock.now += 31 * 1000;
  await app.readStations();
  assert.equal(cercaniasReads(app), before + 1, 'four devices, one request');
  // Aranjuez toward Madrid at night: no train for hours, read every 10 minutes.
  const night = await startApp({
    config: {
      station_1: 'Madrid-Puerta de Atocha-Almudena Grandes',
      station_1_destination: 'sants',
    },
  });
  t.after(() => night.gladys.fake.shutdown());
  const reads = () => night.app.api.requests.byEndpoint[ENDPOINTS.TRIP_UPDATES_LD];
  const quiet = reads();
  night.clock.now += 2 * MINUTE;
  await night.app.readStations();
  assert.equal(reads(), quiet);
  night.clock.now += IDLE_INTERVAL_MS;
  await night.app.readStations();
  assert.equal(reads(), quiet + 1);
  // Long distance only: the Cercanías feeds are never asked.
  assert.equal(night.app.api.requests.byEndpoint[ENDPOINTS.TRIP_UPDATES_CER], undefined);
});

test('the open data down: a clear status; without real time, the timetable', async (t) => {
  const { gladys, app, api, clock } = await startApp();
  t.after(() => gladys.fake.shutdown());
  await created(gladys, ATOCHA);
  api.state.fail = 404;
  await app.trafficTick();
  clock.now += 4 * MINUTE;
  await app.readStations();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /do not answer \(alerts: HTTP 404\)/);
  // The timetable kept in /data still gives the trains.
  assert.match(gladys.fake.lastState(`${ATOCHA}:next`), /\(théorique\)/);
  api.state.fail = null;
  await app.trafficTick();
  await app.readStations();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const realtime = () => app.getSnapshot('18000_60200').passages.filter((p) => p.realtime).length;
  assert.ok(realtime() > 0);
  // The real time alone failing for a while: still connected, the timetable
  // meanwhile.
  api.state.failFeeds = 502;
  clock.now += 4 * MINUTE;
  await app.readStations();
  assert.equal(realtime(), 0);
});

test('a busy real time: asked again after a pause, else the reading of less than 3 min', async (t) => {
  const { gladys, app, api, clock, pauses } = await startApp();
  t.after(() => gladys.fake.shutdown());
  await created(gladys, ATOCHA);
  api.state.busy = 1;
  clock.now += MINUTE;
  await app.readStations();
  assert.equal(pauses.length, 1);
  assert.doesNotMatch(gladys.fake.lastState(`${ATOCHA}:next`), /théorique/);
  // Refused every time: the reading of a minute ago stands in, no error.
  api.state.busy = 100;
  clock.now += MINUTE;
  await app.readStations();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(gladys.fake.lastState(`${ATOCHA}:next`), /théorique/);
  assert.equal(app.api.requests.busy, 1 + BUSY_RETRIES + 1);
  // Too old after 3 minutes: the timetable only.
  clock.now += 3 * MINUTE;
  await app.readStations();
  assert.match(gladys.fake.lastState(`${ATOCHA}:next`), /\(théorique\)/);
});

test('widgets: followed stations, a typed station, lines; valid in every language', async (t) => {
  const { gladys } = await startApp();
  t.after(() => gladys.fake.shutdown());
  for (const language of ['en', 'fr', 'de', 'es']) {
    const answers = [
      await gladys.fake.widgetGet(WIDGETS.DEPARTURES, { settings: {}, language }),
      await gladys.fake.widgetGet(WIDGETS.DEPARTURES, {
        settings: { stations: [ATOCHA, CHAMARTIN] },
        language,
      }),
      await gladys.fake.widgetGet(WIDGETS.DEPARTURES, {
        settings: { station_name: 'Madrid-Atocha Cercanías', line: 'C4a' },
        language,
      }),
      await gladys.fake.widgetGet(WIDGETS.TRAFFIC, { settings: {}, language }),
      await gladys.fake.widgetGet(WIDGETS.TRAFFIC, { settings: { lines: 'C5 Madrid' }, language }),
    ];
    for (const answer of answers) {
      assert.equal(answer.success, true);
      assert.deepEqual(validateWidgetContent(answer.data.content), [], language);
    }
  }
  const typed = await gladys.fake.widgetGet(WIDGETS.DEPARTURES, {
    settings: { station_name: 'Madrid-Atocha Cercanías', line: 'C4a' },
    language: 'fr',
  });
  const [heading, , status] = typed.data.content.components;
  assert.equal(heading.text, 'Madrid-Atocha Cercanías (C4a)');
  assert.deepEqual(
    status.items.map((item) => item.label),
    ['C4a → Alcobendas-San Sebastián …', 'C4a → Parla'],
  );
  const unknown = await gladys.fake.widgetGet(WIDGETS.TRAFFIC, {
    settings: { lines: 'Z9' },
    language: 'en',
  });
  assert.equal(unknown.data.content.components[0].text, 'Unknown or ambiguous: Z9.');
});

test('the traffic widget shows the Cercanías lines of the stations when no line is followed', async (t) => {
  const { gladys } = await startApp({ config: { station_1: 'Madrid-Atocha Cercanías' } });
  t.after(() => gladys.fake.shutdown());
  const traffic = await gladys.fake.widgetGet(WIDGETS.TRAFFIC, { settings: {}, language: 'fr' });
  assert.deepEqual(
    traffic.data.content.components[1].items.map((item) => [item.label, item.value]),
    [
      ['Cercanías Madrid C3', 'Trafic perturbé'],
      ['Cercanías Madrid C4a', 'Trafic perturbé'],
      ['Cercanías Madrid C4b', 'Trafic perturbé'],
    ],
  );
  const longDistance = await startApp({ config: { station_1: '60000' } });
  t.after(() => longDistance.gladys.fake.shutdown());
  const none = await longDistance.gladys.fake.widgetGet(WIDGETS.TRAFFIC, {
    settings: {},
    language: 'en',
  });
  assert.match(none.data.content.components[0].text, /^No Cercanías line is followed/);
});

test('scene actions: next trains of a station, traffic of a line', async (t) => {
  const { gladys, api } = await startApp({ alerts: QUIET });
  t.after(() => gladys.fake.shutdown());
  const next = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_NEXT_DEPARTURES, {
    station: ATOCHA,
  });
  assert.equal(next.success, true);
  const { outputs } = next.data;
  assert.deepEqual(
    [
      outputs.found,
      outputs.line,
      outputs.train_number,
      outputs.destination,
      outputs.minutes,
      outputs.arrival_time,
      outputs.realtime,
    ],
    [true, 'C3', '20108', 'Aranjuez', 22, '23:13', true],
  );
  assert.equal(
    outputs.summary,
    'Prochain train au départ de Madrid-Atocha Cercanías : C3 vers Aranjuez dans 22 min. Le suivant à 23:12.',
  );
  api.state.feeds['alerts.json'] = feedOf([alertC3()]);
  const traffic = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_LINE_TRAFFIC, { line: C3 });
  // A reading of less than 90 s is reused: the alert is not seen yet.
  assert.equal(traffic.data.outputs.state, 'normal');
  const first = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_LINE_TRAFFIC, {});
  assert.deepEqual(
    [first.data.outputs.line_name, first.data.outputs.summary],
    ['Cercanías Madrid C3', 'Cercanías Madrid C3 : Trafic normal.'],
  );
});

test('configuration actions: test, find a station, diagnostic', async (t) => {
  const { gladys, api } = await startApp();
  t.after(() => gladys.fake.shutdown());
  const tested = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.equal(tested.success, true);
  const fr = tested.data.message.fr;
  assert.match(fr, /^Open data Renfe joint : 80 lignes, 319 gares/);
  assert.match(fr, /Madrid-Atocha Cercanías → Aranjuez : 6 train\(s\), prochain C3 dans 22 min/);
  assert.match(
    fr,
    /Cercanías Madrid C3 : Trafic perturbé · Cercanías Madrid C4a : Trafic perturbé/,
  );
  assert.match(fr, /inconnu ou ambigu : Nulle part · inconnu ou ambigu : C9 Bilbao/);
  // The zips asked again with a HEAD; unchanged, not downloaded.
  assert.equal(
    api.calls.filter((call) => call.method === 'GET' && call.path.endsWith('.zip')).length,
    2,
  );
  assert.equal(api.calls.filter((call) => call.method === 'HEAD').length, 2);
  const found = await gladys.fake.action(ACTIONS.SEARCH_STATION, { query: 'atocha' });
  const text = found.data.message.fr;
  assert.match(text, /^Saisissez le nom/);
  assert.match(
    text,
    /\n• Madrid-Atocha Cercanías \[18000\] → AVANT, Intercity, Regional, C3 Madrid, C4a Madrid, C4b Madrid/,
  );
  assert.match(text, /\n• Madrid-Puerta de Atocha-Almudena Grandes \[60000\] → /);
  const short = await gladys.fake.action(ACTIONS.SEARCH_STATION, { query: 'r' });
  assert.match(short.data.message.en, /at least two letters/);
  const none = await gladys.fake.action(ACTIONS.SEARCH_STATION, { query: 'zzz' });
  assert.equal(none.data.message.en, 'No station matches "zzz".');
  const diagnostic = await gladys.fake.action(ACTIONS.DIAGNOSTIC);
  assert.match(diagnostic.data.message.en, /Renfe diagnostic/);
});

test('add, list and remove stations with the buttons, beyond the three of the form', async (t) => {
  const { gladys, app } = await startApp();
  t.after(() => gladys.fake.shutdown());
  const added = await gladys.fake.action(ACTIONS.ADD_STATION, {
    station: 'Madrid-Puerta de Atocha-Almudena Grandes',
    destination: 'sants',
    line: 'AVE',
  });
  assert.match(
    added.data.message.en,
    /^Station added: Madrid-Puerta de Atocha-Almudena Grandes → Barcelona-Sants \(AVE\)\. 3 station\(s\)/,
  );
  assert.deepEqual(gladys.fake.config.added_stations, [
    { station: '60000', destination: '71801', line: 'ld-ave' },
  ]);
  assert.ok(
    gladys.fake.discoveredDevices.some(
      (device) => device.external_id === `${PREFIX}:station:60000_71801_ld-ave`,
    ),
  );
  const snapshot = app.getSnapshot('60000_71801_ld-ave');
  assert.ok(snapshot.passages.length > 0);
  assert.ok(snapshot.passages.every((p) => p.lineId === 'ld-ave'));
  const again = await gladys.fake.action(ACTIONS.ADD_STATION, {
    station: '60000',
    destination: '71801',
    line: 'ave',
  });
  assert.match(again.data.message.en, /already followed/);
  const unknown = await gladys.fake.action(ACTIONS.ADD_STATION, { station: 'Nowhere' });
  assert.equal(unknown.data.message.en, 'Unknown or ambiguous: Nowhere.');
  const list = await gladys.fake.action(ACTIONS.LIST_STATIONS);
  assert.equal(
    list.data.message.fr,
    '4 gare(s) suivie(s) :\n' +
      '1. Madrid-Atocha Cercanías → Aranjuez (formulaire, gare 1)\n' +
      '2. Madrid-Chamartín-Clara Campoamor (formulaire, gare 2)\n' +
      '3. Nulle part (formulaire, gare 3, inconnu ou ambigu)\n' +
      '4. Madrid-Puerta de Atocha-Almudena Grandes → Barcelona-Sants (AVE)',
  );
  const inForm = await gladys.fake.action(ACTIONS.REMOVE_STATION, { station: '2' });
  assert.match(inForm.data.message.en, /is station 2 of the form/);
  const removed = await gladys.fake.action(ACTIONS.REMOVE_STATION, { station: '4' });
  assert.match(removed.data.message.en, /^Station removed: Madrid-Puerta de Atocha/);
  assert.deepEqual(gladys.fake.config.added_stations, []);
  assert.equal(app.getStations().length, 2);
});
