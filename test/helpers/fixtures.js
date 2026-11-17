// A fake Renfe for the tests, served through the `fetch` option of the
// integration. Its answers are real ones, read on 2026-11-17 at 22:05 in
// Madrid (21:05 UTC), the evening of a national railway strike (a third of
// the long distance trains of the day cancelled):
//   - the GTFS of the Cercanías reduced to the lines C3, C4a, C4b and C8a of
//     Madrid, the trips leaving Madrid-Atocha Cercanías or Madrid-Chamartín
//     on Tuesday 17 from 21:30 to 23:59 and on Wednesday 18 from 05:30 to
//     07:30 (every station they serve); routes.txt is whole, padded with
//     spaces as Renfe writes it;
//   - the GTFS of the long distance reduced to the trips leaving Madrid
//     (Puerta de Atocha, Chamartín, Atocha Cercanías) on the 17th from 20:00
//     and on the 18th from 05:00 to 09:00, and the trips of the real time of
//     that minute calling at Madrid or Barcelona-Sants;
//   - the GTFS-RT of that minute in JSON (trip updates of the two networks,
//     the vehicle positions and the alerts of the Cercanías), reduced to
//     those trips and to some alerts.
// Open data of Renfe (data.renfe.com). Tests never touch the network: the
// zips are built here.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { readGtfs } from '../../src/gtfs.js';
import { linesOf, mergeStations, NETWORKS } from '../../src/network.js';
import { readTripUpdates, readVehicles } from '../../src/realtime.js';
import { buildPassages, indexTripUpdates } from '../../src/departures.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);
// The time of the trip updates of the fixture: 2026-11-17 22:05:03 in Madrid.
const NOW = 1794949503 * 1000;
const TZ = 'Europe/Madrid';
const GTFS_URLS = {
  ld: 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
  cer: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
};
const FEEDS_URL = 'https://gtfsrt.renfe.com';
// The dates of the zips of the fixture, as Renfe sends them.
const LAST_MODIFIED = {
  ld: 'Tue, 17 Nov 2026 00:05:40 GMT',
  cer: 'Tue, 17 Nov 2026 03:15:12 GMT',
};

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @description A temporary path for the file kept in /data.
 * @returns {string} The path (its directory exists, the file does not).
 */
const storePath = () => join(mkdtempSync(join(tmpdir(), 'renfe-')), 'renfe.json');

// --- Zip ------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

/**
 * @description The CRC-32 of some bytes.
 * @param {Buffer} buf - The bytes.
 * @returns {number} The CRC.
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @description A zip archive.
 * @param {object} files - `{ name: text | Buffer }`.
 * @param {object} [options] - `{ store }`: no compression.
 * @returns {Buffer} The archive.
 */
function makeZip(files, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * @description The files of a GTFS of the fixture.
 * @param {string} network - `ld` or `cer`.
 * @returns {object} `{ "stops.txt": text, … }`.
 */
function gtfsFiles(network) {
  const dir = new URL(`gtfs/${network}/`, FIXTURES);
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]),
  );
}

const GTFS_ZIPS = { ld: makeZip(gtfsFiles('ld')), cer: makeZip(gtfsFiles('cer')) };

// --- Feeds ----------------------------------------------------------------------------

const readFixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const TRIP_UPDATES_CER = readFixture('trip_updates.json');
const TRIP_UPDATES_LD = readFixture('trip_updates_LD.json');
const VEHICLES = readFixture('vehicle_positions.json');
const ALERTS = readFixture('alerts.json');

/**
 * @description A GTFS-RT feed in JSON, written like Renfe writes it.
 * @param {object[]} entities - Its entities.
 * @param {number} [timestamp] - Unix seconds.
 * @returns {object} The feed.
 */
const feedOf = (entities, timestamp = NOW / 1000) => ({
  header: { gtfsRealtimeVersion: '2.0', timestamp: String(timestamp) },
  entity: entities,
});

/**
 * @description A trip update, written like Renfe writes it.
 * @param {string} tripId - The trip.
 * @param {object} [fields] - `{ cancelled, stopId, time (s), delay (s), skipped: [stopId] }`.
 * @returns {object} The entity.
 */
function tripUpdate(tripId, { cancelled = false, stopId, time, delay = 0, skipped = [] } = {}) {
  if (cancelled) {
    return {
      id: `TUCANCEL_${tripId}`,
      tripUpdate: { trip: { tripId, scheduleRelationship: 'CANCELED' } },
    };
  }
  return {
    id: `TUUPDATE_${tripId}`,
    tripUpdate: {
      trip: { tripId, scheduleRelationship: 'SCHEDULED' },
      stopTimeUpdate: [
        { arrival: { delay, time: String(time) }, stopId },
        ...skipped.map((id) => ({ stopId: id, scheduleRelationship: 'SKIPPED' })),
      ],
      delay,
    },
  };
}

/**
 * @description An alert, written like Renfe writes them.
 * @param {object} [fields] - What differs from an alert about C3 of Madrid
 * under way at the time of the fixtures.
 * @returns {object} The entity.
 */
const alertC3 = (fields = {}) => ({
  id: fields.id ?? 'AVISO_TEST',
  alert: {
    activePeriod: fields.periods ?? [{ start: String(NOW / 1000 - 3600) }],
    informedEntity: (fields.routeIds ?? ['10T0007C3', '10T0008C3']).map((routeId) => ({ routeId })),
    descriptionText: {
      translation: [
        {
          text:
            fields.text ??
            '#MadC3 Por una incidencia en la infraestructura, los trenes de la línea C3 circulan con retrasos entre Pinto y Aranjuez.',
          language: 'es',
        },
      ],
    },
  },
});

/**
 * @description An instant of the evening of the fixtures, in Madrid, on the
 * service day of Tuesday 17 November.
 * @param {string} time - "22:30", "24:20:30" (after midnight), "30:10".
 * @returns {number} The instant (ms).
 */
function madrid(time) {
  const [hours, minutes, seconds = 0] = time.split(':').map(Number);
  // 2026-11-17 in Madrid is UTC+1.
  return Date.parse('2026-11-17T00:00:00+01:00') + ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * @description A train, as buildPassages() writes it.
 * @param {object} [fields] - What differs from a C3 towards Aranjuez,
 * scheduled at 22:28, followed in real time and on time. `time` the
 * scheduled Madrid time, `delay` minutes.
 * @returns {object} The passage.
 */
function passage({
  time = '22:28',
  delay = 0,
  line = 'C3',
  lineId = '10-c3',
  network = 'cer',
  number = '23525',
  destination = 'Aranjuez',
  realtime = true,
  cancelled = false,
  track = '',
  arrival = null,
  trip,
} = {}) {
  const scheduled = madrid(time);
  return {
    lineId,
    line,
    network,
    number,
    destination,
    at: scheduled + (realtime ? delay : 0) * 60000,
    scheduled,
    arrival,
    scheduledArrival: arrival,
    realtime,
    delay: realtime ? delay : 0,
    cancelled,
    track,
    trip: trip ?? `${line}-${time}`,
    platform: '18000',
  };
}

/**
 * @description The reference data of the two GTFS of the fixtures.
 * @returns {Promise<{ lines: object[], stations: object[] }>} Lines and stations.
 */
async function fixtureNetwork() {
  const lines = [];
  const sources = [];
  for (const network of [NETWORKS.LD, NETWORKS.CER]) {
    const gtfs = await readGtfs(GTFS_ZIPS[network], { from: '20261116', to: '20261130' });
    const own = linesOf(gtfs.routes, network);
    lines.push(...own);
    sources.push({
      stops: gtfs.stops,
      linesByStop: gtfs.linesByStop,
      routeLine: new Map(own.flatMap((line) => line.routeIds.map((id) => [id, line.id]))),
    });
  }
  return { lines, stations: mergeStations(sources) };
}

/**
 * @description The trains of a station of the fixtures, at the time of the
 * fixtures: the reduced GTFS corrected by the real feeds.
 * @param {string} code - The station code ("18000").
 * @param {object} [filter] - `{ destination (code), line (id), realtime }`:
 * `realtime` false for the timetable only.
 * @returns {Promise<object[]>} The passages.
 */
async function fixturePassages(code, { destination = '', line = '', realtime = true } = {}) {
  const { lines, stations } = await fixtureNetwork();
  const station = stations.find((item) => item.code === code);
  const target = destination ? stations.find((item) => item.code === destination) : null;
  const timetable = { from: '20261116', to: '20261123', services: {}, trips: {}, rows: [] };
  for (const network of [NETWORKS.LD, NETWORKS.CER]) {
    const gtfs = await readGtfs(GTFS_ZIPS[network], {
      stopIds: new Set([code, destination].filter(Boolean)),
      from: '20261116',
      to: '20261123',
    });
    Object.assign(timetable.services, gtfs.timetable.services);
    Object.assign(timetable.trips, gtfs.timetable.trips);
    timetable.rows.push(...gtfs.timetable.rows);
  }
  return buildPassages({
    timetable,
    station,
    destination: target,
    line: line ? lines.find((item) => item.id === line) : null,
    realtime: realtime
      ? indexTripUpdates(readTripUpdates(TRIP_UPDATES_CER), readTripUpdates(TRIP_UPDATES_LD))
      : null,
    vehicles: realtime ? readVehicles(VEHICLES) : null,
    now: NOW,
    lineOfRoute: (id) => lines.find((item) => item.routeIds.includes(id)) ?? null,
  });
}

/**
 * @description The fake Renfe: the two zips (HEAD and GET) and the four feeds.
 * @returns {Function} A fetch function, with `.calls` and `.state`.
 */
function fakeRenfe() {
  const state = {
    zips: { ...GTFS_ZIPS },
    lastModified: { ...LAST_MODIFIED },
    feeds: {
      'trip_updates.json': TRIP_UPDATES_CER,
      'trip_updates_LD.json': TRIP_UPDATES_LD,
      'vehicle_positions.json': VEHICLES,
      'alerts.json': ALERTS,
    },
    // 'network', or an HTTP status, for every request; `failFeeds` for the
    // feeds alone (a status), `failGtfs` for the zips; `busy`: how many next
    // feed requests get a 503.
    fail: null,
    failFeeds: null,
    failGtfs: null,
    busy: 0,
  };
  const calls = [];

  /**
   * @description The fetch function.
   * @param {string} url - The URL.
   * @param {object} [init] - `{ method }`.
   * @returns {Promise<Response>} The answer.
   */
  async function fetchFn(url, init = {}) {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.split('/').pop();
    calls.push({ url, path, method });
    if (state.fail === 'network') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (typeof state.fail === 'number') {
      return new Response('Service Unavailable', { status: state.fail });
    }
    const network = Object.entries(GTFS_URLS).find(([, value]) => value === url)?.[0];
    if (network) {
      if (state.failGtfs) {
        return new Response('Bad Gateway', { status: state.failGtfs });
      }
      const headers = {
        'content-type': 'application/zip',
        'content-length': String(state.zips[network].length),
        'last-modified': state.lastModified[network],
      };
      return new Response(method === 'HEAD' ? null : state.zips[network], {
        status: 200,
        headers,
      });
    }
    if (!url.startsWith(FEEDS_URL) || !state.feeds[path]) {
      return new Response('Not Found', { status: 404 });
    }
    if (state.failFeeds) {
      return new Response('Bad Gateway', { status: state.failFeeds });
    }
    if (state.busy > 0) {
      state.busy -= 1;
      return new Response('Service Unavailable', { status: 503 });
    }
    return Response.json(state.feeds[path]);
  }
  fetchFn.calls = calls;
  fetchFn.state = state;
  return fetchFn;
}

/**
 * @description A minimal Gladys client for the pure builders.
 */
const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:renfe:${type}:${id}`,
    feature: (key) => `ext:renfe:${type}:${id}:${key}`,
  }),
};

export {
  NOW,
  TZ,
  GTFS_URLS,
  FEEDS_URL,
  LAST_MODIFIED,
  GTFS_ZIPS,
  TRIP_UPDATES_CER,
  TRIP_UPDATES_LD,
  VEHICLES,
  ALERTS,
  silent,
  storePath,
  crc32,
  makeZip,
  gtfsFiles,
  feedOf,
  tripUpdate,
  alertC3,
  madrid,
  passage,
  fixtureNetwork,
  fixturePassages,
  fakeRenfe,
  fakeGladys,
};
