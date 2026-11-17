import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  fold,
  slug,
  nucleoOf,
  nucleoName,
  linesOf,
  findLine,
  findStation,
  searchStations,
  mergeStations,
  gtfsDate,
  createNetwork,
} from '../src/network.js';
import { createRenfeClient } from '../src/renfe-api.js';
import { createStore } from '../src/store.js';
import { newDaySince } from '../src/time.js';
import {
  NOW,
  TZ,
  GTFS_ZIPS,
  LAST_MODIFIED,
  GTFS_URLS,
  fakeRenfe,
  fixtureNetwork,
  storePath,
  silent,
} from './helpers/fixtures.js';

const { lines, stations } = await fixtureNetwork();

test('names folded for comparisons, slugs for the ids, the núcleos', () => {
  assert.equal(fold('Madrid-Chamartín-Clara Campoamor'), 'madrid chamartin clara campoamor');
  assert.equal(slug('AVE Euromed'), 'ave-euromed');
  assert.equal(gtfsDate(NOW, TZ), '20261117');
  assert.equal(nucleoOf('10T0001C1'), '10');
  assert.equal(nucleoOf('1700037606GL023'), '');
  assert.equal(nucleoName('51'), 'Rodalies de Catalunya');
  assert.equal(nucleoName('99'), '99');
});

test('lines: the products of long distance, the Cercanías lines of each núcleo', () => {
  const c3 = lines.find((line) => line.id === '10-c3');
  assert.deepEqual(c3, {
    id: '10-c3',
    name: 'C3',
    network: 'cer',
    nucleo: '10',
    nucleoName: 'Madrid',
    color: c3.color,
    routeIds: ['10T0007C3', '10T0008C3'],
  });
  assert.match(c3.color, /^#[0-9A-F]{6}$/);
  const ave = lines.find((line) => line.id === 'ld-ave');
  assert.equal(ave.network, 'ld');
  assert.ok(ave.routeIds.length > 5);
  // "C1" in ten núcleos, once each.
  assert.ok(lines.filter((line) => line.name === 'C1').length >= 10);
  assert.deepEqual(
    linesOf([{ id: 'X', shortName: 'Regional', color: '' }], 'ld').map((line) => line.id),
    ['ld-regional'],
  );
});

test('a line is typed with its núcleo, or alone when it is unique or near', () => {
  const id = (typed, near) => findLine(lines, typed, { near })?.id ?? null;
  assert.equal(id('C3 Madrid'), '10-c3');
  assert.equal(id('madrid c3'), '10-c3');
  assert.equal(id('Cercanías Madrid C-3'), '10-c3');
  assert.equal(id('C1 Sevilla'), '30-c1');
  assert.equal(id('línea C5 Madrid'), '10-c5');
  assert.equal(id('R2N'), '51-r2n');
  assert.equal(id('Rodalies R2'), '51-r2');
  assert.equal(id('AVE'), 'ld-ave');
  assert.equal(id('Avlo'), 'ld-avlo');
  assert.equal(id('10-c4a'), '10-c4a');
  // Ten "C1": unknown alone, known near a station of Madrid.
  assert.equal(id('C1'), null);
  assert.equal(id('C1', ['10-c1', 'ld-ave']), '10-c1');
  assert.equal(id('C9 Bilbao'), null);
  assert.equal(id('Z9'), null);
  assert.equal(id(''), null);
});

test('stations: the two GTFS merged on the codes of Adif', () => {
  const atocha = stations.find((station) => station.code === '18000');
  assert.equal(atocha.name, 'Madrid-Atocha Cercanías');
  assert.deepEqual(atocha.ids, ['18000']);
  // The trains of both files call there.
  assert.ok(atocha.lines.includes('10-c3') && atocha.lines.includes('ld-regional'));
  assert.equal(new Set(stations.map((station) => station.code)).size, stations.length);
  const merged = mergeStations([
    {
      stops: [{ id: '1', name: 'A', lat: 1, lon: 2 }],
      linesByStop: { 1: ['r1'] },
      routeLine: new Map([['r1', 'ld-ave']]),
    },
    {
      stops: [{ id: '1', name: 'A', lat: 1, lon: 2 }],
      linesByStop: { 1: ['c'] },
      routeLine: new Map([['c', '10-c1']]),
    },
  ]);
  assert.deepEqual(merged, [
    { code: '1', name: 'A', ids: ['1'], lines: ['ld-ave', '10-c1'], lat: 1, lon: 2 },
  ]);
});

test('a station is typed by its name, a few of its words or its code', () => {
  const name = (typed) => findStation(stations, typed)?.name ?? null;
  assert.equal(name('chamartin'), 'Madrid-Chamartín-Clara Campoamor');
  assert.equal(name('Madrid-Atocha Cercanías'), 'Madrid-Atocha Cercanías');
  assert.equal(name('ARANJUEZ'), 'Aranjuez');
  assert.equal(name('sants'), 'Barcelona-Sants');
  assert.equal(name('60000'), 'Madrid-Puerta de Atocha-Almudena Grandes');
  // Two stations hold "atocha": the user says which.
  assert.equal(name('atocha'), null);
  assert.equal(name('Nulle part'), null);
  assert.equal(name(''), null);
  assert.deepEqual(
    searchStations(stations, 'atocha').map((station) => station.code),
    ['18000', '60000'],
  );
  assert.deepEqual(searchStations(stations, '  '), []);
});

/**
 * @description A network on the fake Renfe, with its store.
 * @param {object} [options] - `{ path, clock }`.
 * @returns {Promise<object>} `{ network, api, fetch, store, clock, path }`.
 */
async function network({ path = storePath(), clock = { now: NOW } } = {}) {
  const fetch = fakeRenfe();
  const api = createRenfeClient({ fetch, now: () => clock.now });
  const store = createStore({ path });
  await store.load();
  return {
    network: createNetwork({
      api,
      store,
      zipPaths: {
        ld: join(dirname(path), 'renfe-ld.zip'),
        cer: join(dirname(path), 'renfe-cer.zip'),
      },
      now: () => clock.now,
      isNewDay: (since) => newDaySince(since, clock.now, TZ),
      timeZone: TZ,
      logger: silent,
    }),
    api,
    fetch,
    store,
    clock,
    path,
  };
}

const calls = (fetch) =>
  fetch.calls.map((call) => `${call.method} ${call.url === GTFS_URLS.ld ? 'ld' : 'cer'}`);

test('the timetables are read once, kept with the zips, asked again daily', async () => {
  const first = await network();
  assert.equal((await first.network.lines()).length, lines.length);
  assert.equal((await first.network.stations()).length, stations.length);
  assert.deepEqual(calls(first.fetch), ['GET ld', 'GET cer']);
  assert.deepEqual(first.store.data.network.versions, {
    ld: `${GTFS_ZIPS.ld.length}@${Date.parse(LAST_MODIFIED.ld)}`,
    cer: `${GTFS_ZIPS.cer.length}@${Date.parse(LAST_MODIFIED.cer)}`,
  });
  assert.ok(existsSync(join(dirname(first.path), 'renfe-cer.zip')));
  // A restart: the store and the zips, nothing downloaded.
  const restart = await network({ path: first.path });
  assert.equal((await restart.network.resolveLine('C3 Madrid')).id, '10-c3');
  assert.equal(restart.fetch.calls.length, 0);
  // The next day after 06:00: a HEAD each, the zips are unchanged (another
  // server of Renfe dates the same zip two seconds later).
  restart.clock.now = NOW + 12 * 3600 * 1000;
  restart.fetch.state.lastModified.ld = 'Tue, 17 Nov 2026 00:05:42 GMT';
  await restart.network.lines();
  assert.deepEqual(calls(restart.fetch), ['HEAD ld', 'HEAD cer']);
  assert.equal(restart.api.requests.notModified, 2);
  // A failure keeps what is known.
  restart.fetch.state.fail = 503;
  assert.equal((await restart.network.lines(true)).length, lines.length);
  // A new zip: downloaded and read.
  restart.fetch.state.fail = null;
  restart.fetch.state.lastModified.cer = 'Wed, 18 Nov 2026 03:15:02 GMT';
  restart.fetch.calls.length = 0;
  await restart.network.lines(true);
  assert.deepEqual(calls(restart.fetch), ['HEAD ld', 'HEAD cer', 'GET cer']);
  assert.equal(
    restart.store.data.network.versions.cer,
    `${GTFS_ZIPS.cer.length}@${Date.parse('Wed, 18 Nov 2026 03:15:02 GMT')}`,
  );
});

test('a zip not read is asked again half an hour later', async () => {
  const { network: net, fetch, clock } = await network();
  fetch.state.failGtfs = 502;
  await assert.rejects(net.lines(), { kind: 'unreachable' });
  fetch.state.failGtfs = null;
  await net.lines();
  // The zips fail today: the ones kept serve meanwhile.
  clock.now = NOW + 12 * 3600 * 1000;
  fetch.state.failGtfs = 502;
  await net.lines();
  fetch.state.failGtfs = null;
  fetch.calls.length = 0;
  clock.now += 10 * 60 * 1000;
  await net.lines();
  assert.equal(fetch.calls.length, 0);
  clock.now += 25 * 60 * 1000;
  await net.lines();
  assert.deepEqual(calls(fetch), ['HEAD ld', 'HEAD cer']);
});

test('the timetable of the stations: from the zips serving them, kept while it holds them', async () => {
  const { network: net } = await network();
  const atocha = await net.resolveStation('Madrid-Atocha Cercanías');
  const aranjuez = await net.resolveStation('aranjuez');
  const first = await net.timetable([atocha]);
  assert.deepEqual(first.codes, ['18000']);
  assert.equal(first.from, '20261116');
  assert.equal(first.to, '20261123');
  assert.ok(first.rows.every(([, stopId]) => stopId === '18000'));
  // The trips of both networks.
  assert.ok(
    first.trips['1020M20108C3'] && Object.keys(first.trips).some((id) => /^\d+2026-/.test(id)),
  );
  assert.equal(await net.timetable([atocha]), first);
  const both = await net.timetable([aranjuez]);
  assert.deepEqual(both.codes, ['18000', '60200']);
  assert.equal(net.describeTimetable().stations.length, 2);
  assert.equal(net.lineOfRoute('10T0008C3').id, '10-c3');
  assert.equal(net.peekLine('ld-ave').name, 'AVE');
});
