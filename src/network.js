// -----------------------------------------------------------------------------
// The reference data of Renfe, from its two GTFS (gtfs.js):
//
//   - the zips are kept in /data; once a day, after 06:00, a HEAD tells
//     whether Renfe published new ones (their size or date changes), and only then
//     are they downloaded;
//   - stations: the stops of the two files, merged on their code (the codes
//     of Adif, "17000" for Madrid-Chamartín-Clara Campoamor, the same in the
//     two files, 1 505 stations, no two of one name). A station is typed by
//     name ("Chamartín", "madrid atocha cercanias") or by its code. A name
//     typed with other words resolves when one station only holds them all;
//   - lines: the long distance products ("AVE", "Avlo", "Alvia",
//     "Intercity", "Regional"…: id `ld-ave`), and the Cercanías lines of each
//     núcleo ("C3" of Madrid: id `10-c3`, the two first digits of its route
//     ids; Renfe writes one route per direction). "C1" exists in ten núcleos:
//     a line is typed with its núcleo ("C3 Madrid", "Rodalies R2N"), or
//     alone when the stations followed tell which one;
//   - the timetable of the followed stations: their trains over eight service
//     days (yesterday to six days ahead), read from the zips kept, in memory
//     only, rebuilt each day and when a station is added.
//
// Names are compared folded: no case, no accent, no punctuation.
// -----------------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { readGtfs } from './gtfs.js';
import { localClock } from './time.js';

const DAY_MS = 24 * 3600 * 1000;
// A timetable that could not be read is asked again this much later.
const RETRY_MS = 30 * 60 * 1000;
const NETWORKS = { LD: 'ld', CER: 'cer' };
// The núcleos of Cercanías, by the two first digits of their route ids.
const NUCLEOS = {
  10: 'Madrid',
  20: 'Asturias',
  30: 'Sevilla',
  31: 'Cádiz',
  32: 'Málaga',
  40: 'Valencia',
  41: 'Murcia/Alicante',
  45: 'Cartagena',
  46: 'Ferrol',
  47: 'León',
  50: 'Barcelona',
  51: 'Rodalies de Catalunya',
  60: 'Bilbao',
  61: 'San Sebastián',
  62: 'Santander',
  70: 'Zaragoza',
};
// Words that only say "a line": "línea C3", "Cercanías Madrid C3".
const FILLER_WORDS = new Set([
  'linea',
  'line',
  'ligne',
  'linie',
  'tren',
  'train',
  'zug',
  'cercanias',
  'rodalies',
  'nucleo',
  'renfe',
  'de',
]);

/**
 * @description Fold a text for comparisons.
 * @param {unknown} value - The text.
 * @returns {string} Lower case, no accent, words separated by one space.
 * @example
 * fold('Madrid-Chamartín-Clara Campoamor'); // -> 'madrid chamartin clara campoamor'
 */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @description A slug for an external id.
 * @param {unknown} value - The text.
 * @param {number} [max] - Its longest length.
 * @returns {string} "c4a".
 */
function slug(value, max = 40) {
  return fold(value).replace(/ /g, '-').slice(0, max).replace(/-$/, '');
}

/**
 * @description The núcleo of a Cercanías route.
 * @param {string} routeId - "10T0001C1".
 * @returns {string} "10", '' when not a Cercanías route id.
 */
const nucleoOf = (routeId) => /^(\d{2})T/.exec(String(routeId))?.[1] ?? '';

/**
 * @description The name of a núcleo.
 * @param {string} nucleo - "10".
 * @returns {string} "Madrid", the code when unknown.
 */
const nucleoName = (nucleo) => NUCLEOS[nucleo] ?? nucleo;

/**
 * @description The lines of a GTFS: the routes gathered by public name (and
 * núcleo for the Cercanías).
 * @param {object[]} routes - The routes of the GTFS.
 * @param {string} network - NETWORKS.
 * @returns {object[]} `[{ id, name, network, nucleo, nucleoName, color,
 * routeIds }]`.
 */
function linesOf(routes, network) {
  const byKey = new Map();
  for (const route of routes) {
    const name = String(route.shortName || route.id).trim();
    const nucleo = network === NETWORKS.CER ? nucleoOf(route.id) : '';
    const id = network === NETWORKS.CER ? `${nucleo || 'x'}-${slug(name)}` : `ld-${slug(name)}`;
    const line = byKey.get(id) ?? {
      id,
      name,
      network,
      nucleo,
      nucleoName: nucleo ? nucleoName(nucleo) : '',
      color: /^[0-9a-f]{6}$/i.test(route.color ?? '') ? `#${route.color.toUpperCase()}` : '',
      routeIds: [],
    };
    line.routeIds.push(String(route.id));
    byKey.set(id, line);
  }
  return [...byKey.values()];
}

/**
 * @description The order of lines: the long distance products, then the
 * Cercanías by núcleo and name.
 * @param {object} a - A line.
 * @param {object} b - Another one.
 * @returns {number} The order.
 */
const byLine = (a, b) =>
  Number(a.network === NETWORKS.CER) - Number(b.network === NETWORKS.CER) ||
  a.nucleo.localeCompare(b.nucleo) ||
  a.name.localeCompare(b.name, 'es', { numeric: true });

/**
 * @description The stations of the two GTFS, merged on their code.
 * @param {Array<{ stops: object[], linesByStop: object, routeLine: Map }>} sources -
 * Per GTFS: its stops, the routes calling at each, route id -> line id.
 * @returns {object[]} `[{ code, name, ids, lines, lat, lon }]`, `ids` `[code]`
 * (departures.js reads the stations of a stop), `lines` the line ids.
 */
function mergeStations(sources) {
  const byCode = new Map();
  for (const { stops, linesByStop, routeLine } of sources) {
    for (const stop of stops) {
      const station = byCode.get(stop.id) ?? {
        code: stop.id,
        name: stop.name,
        ids: [stop.id],
        lines: [],
        lat: Math.round(stop.lat * 1e5) / 1e5,
        lon: Math.round(stop.lon * 1e5) / 1e5,
      };
      for (const routeId of linesByStop[stop.id] ?? []) {
        const lineId = routeLine.get(routeId);
        if (lineId && !station.lines.includes(lineId)) {
          station.lines.push(lineId);
        }
      }
      byCode.set(stop.id, station);
    }
  }
  return [...byCode.values()].sort(
    (a, b) => fold(a.name).localeCompare(fold(b.name), 'es') || a.code.localeCompare(b.code),
  );
}

/**
 * @description Find lines among the known ones.
 * @param {object[]} lines - The known lines.
 * @param {string} typed - "C3 Madrid", "AVE", "R2N", "10-c3".
 * @param {object} [options] - `{ near }`: the line ids calling at the
 * followed stations, which tell a "C1" of which núcleo.
 * @returns {object|null} The line, null when unknown or ambiguous.
 * @example
 * findLine(lines, 'C3 Madrid'); // -> { id: '10-c3', name: 'C3', … }
 */
function findLine(lines, typed, { near = [] } = {}) {
  const raw = String(typed ?? '').trim();
  if (!raw) {
    return null;
  }
  const byId = lines.find((line) => line.id === raw.toLowerCase());
  if (byId) {
    return byId;
  }
  const words = fold(raw)
    .split(' ')
    .filter((word) => word && !FILLER_WORDS.has(word));
  if (words.length === 0) {
    return null;
  }
  const compact = (value) => fold(value).replace(/ /g, '');
  // "C-5" and "C 5" are "c5": the name may take several words.
  let candidates = [];
  let rest = [];
  for (let size = Math.min(3, words.length); size >= 1 && candidates.length === 0; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const name = words.slice(start, start + size).join('');
      const found = lines.filter((line) => compact(line.name) === name);
      if (found.length > 0) {
        candidates = found;
        rest = [...words.slice(0, start), ...words.slice(start + size)];
        break;
      }
    }
  }
  if (rest.length > 0) {
    const place = rest.join(' ');
    candidates = candidates.filter((line) => {
      const label =
        line.network === NETWORKS.LD ? 'larga distancia long distance' : fold(line.nucleoName);
      return ` ${label} `.includes(` ${place}`) || line.nucleo === place;
    });
  }
  if (candidates.length > 1 && near.length > 0) {
    const close = candidates.filter((line) => near.includes(line.id));
    if (close.length > 0) {
      candidates = close;
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * @description Find a station among the known ones.
 * @param {object[]} stations - The known stations.
 * @param {string} typed - A name or a code ("17000", "5102" for "05102").
 * @returns {object|null} The station.
 * @example
 * findStation(stations, 'chamartin'); // -> { code: '17000', … }
 */
function findStation(stations, typed) {
  const raw = String(typed ?? '').trim();
  if (!raw) {
    return null;
  }
  if (/^\d{4,5}$/.test(raw)) {
    const code = raw.padStart(5, '0');
    const byCode = stations.find((station) => station.code === code);
    if (byCode) {
      return byCode;
    }
  }
  const wanted = fold(raw);
  if (!wanted) {
    return null;
  }
  const exact = stations.filter((station) => fold(station.name) === wanted);
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : null;
  }
  // A unique station holding every typed word ("chamartin" -> "Madrid-
  // Chamartín-Clara Campoamor").
  const words = wanted.split(' ');
  const holding = stations.filter((station) =>
    words.every((word) => ` ${fold(station.name)} `.includes(` ${word}`)),
  );
  return holding.length === 1 ? holding[0] : null;
}

/**
 * @description Search stations by name, for the "Find a station" button.
 * @param {object[]} stations - The known stations.
 * @param {string} query - Words of the name.
 * @param {number} [max] - The most stations returned.
 * @returns {object[]} The stations, exact names first, then names starting so.
 */
function searchStations(stations, query, max = 8) {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const wanted = words.join(' ');
  const rank = (station) => {
    const name = fold(station.name);
    if (name === wanted) {
      return 0;
    }
    return name.startsWith(wanted) ? 1 : 2;
  };
  return stations
    .filter((station) => words.every((word) => ` ${fold(station.name)} `.includes(` ${word}`)))
    .sort(
      (a, b) =>
        rank(a) - rank(b) || b.lines.length - a.lines.length || a.name.localeCompare(b.name, 'es'),
    )
    .slice(0, max);
}

/**
 * @description A GTFS date, from a local date.
 * @param {number} instant - The instant (ms).
 * @param {string} [timeZone] - IANA timezone.
 * @returns {string} "20261117".
 */
const gtfsDate = (instant, timeZone) => localClock(instant, timeZone).date.replace(/-/g, '');

/**
 * @description The reference data and the timetables, through the API, kept
 * in the store and in two zips next to it.
 * @param {object} options - Options.
 * @param {object} options.api - Renfe client.
 * @param {object} options.store - The store (`data.network`).
 * @param {object} options.zipPaths - `{ ld, cer }`: where the zips are kept.
 * @param {Function} options.now - `() => number` in ms.
 * @param {Function} options.isNewDay - `(readAt) => boolean`: a 06:00 passed since.
 * @param {string} [options.timeZone] - IANA timezone of the network.
 * @param {object} [options.logger] - Logger.
 * @returns {object} The network.
 */
function createNetwork({
  api,
  store,
  zipPaths,
  now,
  isNewDay,
  timeZone = 'Europe/Madrid',
  logger,
}) {
  // In memory only: rebuilt from the zips.
  let timetable = null;
  let checking = null;
  let building = null;
  const zipCache = {};
  const networks = Object.values(NETWORKS);

  const data = () => {
    if (!store.data.network || typeof store.data.network !== 'object') {
      store.data.network = {
        lines: null,
        stations: null,
        versions: {},
        checkedAt: 0,
        retryAt: 0,
      };
    }
    store.data.network.versions ??= {};
    return store.data.network;
  };
  const known = () => Boolean(data().lines && data().stations);

  /**
   * @description A zip kept, read once.
   * @param {string} network - NETWORKS.
   * @returns {Promise<Buffer|null>} Its bytes, null when absent.
   */
  async function readZip(network) {
    if (zipCache[network]) {
      return zipCache[network];
    }
    try {
      zipCache[network] = await readFile(zipPaths[network]);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger?.warn(`Unable to read ${zipPaths[network]}: ${err.message}`);
      }
      return null;
    }
    return zipCache[network];
  }

  /**
   * @description Keep a new zip (atomically).
   * @param {string} network - NETWORKS.
   * @param {Buffer} zip - The archive.
   * @returns {Promise<void>}
   */
  async function writeZip(network, zip) {
    zipCache[network] = zip;
    const path = zipPaths[network];
    try {
      await mkdir(path.slice(0, path.lastIndexOf('/')) || '.', { recursive: true });
      await writeFile(`${path}.tmp`, zip);
      await rename(`${path}.tmp`, path);
    } catch (err) {
      logger?.warn(`Unable to write ${path}: ${err.message}`);
    }
  }

  /**
   * @description Read the lines and stations of the zips into the store.
   * @returns {Promise<void>}
   */
  async function adopt() {
    // The lines of each station from the trips of two weeks around today:
    // reading the month of trips of the Cercanías would not fit in 256 MB.
    const current = now();
    const window = {
      from: gtfsDate(current - DAY_MS, timeZone),
      to: gtfsDate(current + 13 * DAY_MS, timeZone),
    };
    const lines = [];
    const sources = [];
    for (const network of networks) {
      const zip = await readZip(network);
      if (!zip) {
        continue;
      }
      const gtfs = await readGtfs(zip, window);
      const own = linesOf(gtfs.routes, network);
      const routeLine = new Map(own.flatMap((line) => line.routeIds.map((id) => [id, line.id])));
      lines.push(...own);
      sources.push({ stops: gtfs.stops, linesByStop: gtfs.linesByStop, routeLine });
    }
    const stations = mergeStations(sources);
    if (lines.length === 0 || stations.length === 0) {
      throw Object.assign(new Error('empty timetable'), { kind: 'invalid' });
    }
    Object.assign(data(), { lines: lines.sort(byLine), stations });
  }

  /**
   * @description Ask for the zips again when a new day began (or when
   * forced), and read them when they changed. A failure keeps what is known.
   * @param {boolean} [force] - Ask even when checked today.
   * @returns {Promise<void>}
   */
  function check(force = false) {
    const kept = data();
    const retry = kept.retryAt && now() >= kept.retryAt;
    if (known() && !isNewDay(kept.checkedAt) && !retry && !force) {
      return Promise.resolve();
    }
    checking ??= (async () => {
      try {
        let changed = false;
        let failure = null;
        for (const network of networks) {
          try {
            const zipKept = await readZip(network);
            // Without the zip on disk, the version kept means nothing.
            const answer = await api.gtfs(network, zipKept ? (kept.versions[network] ?? '') : '');
            if (answer) {
              await writeZip(network, answer.zip);
              kept.versions[network] = answer.lastModified;
              changed = true;
              logger?.info(
                `Renfe ${network} timetable read (${answer.zip.length} bytes, ${answer.lastModified})`,
              );
            }
          } catch (err) {
            failure ??= err;
          }
        }
        const present = (await Promise.all(networks.map(readZip))).filter(Boolean).length;
        if (present === 0) {
          throw failure ?? new Error('no timetable');
        }
        if (changed || !known()) {
          await adopt();
          timetable = null;
        }
        kept.checkedAt = now();
        // A zip not read is asked again a little later, not tomorrow.
        kept.retryAt = failure ? now() + RETRY_MS : 0;
        if (failure) {
          logger?.warn(
            `Renfe timetable not read again (${failure.kind ?? 'error'}): ${failure.message}`,
          );
        }
        await store.save();
      } catch (err) {
        if (!known()) {
          throw err;
        }
        kept.retryAt = now() + RETRY_MS;
        logger?.warn(`Renfe timetable not read again (${err.kind ?? 'error'}): ${err.message}`);
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  /**
   * @description The lines.
   * @param {boolean} [force] - Ask for the timetables again.
   * @returns {Promise<object[]>} The lines.
   */
  async function lines(force = false) {
    await check(force);
    return data().lines;
  }

  /**
   * @description The stations.
   * @param {boolean} [force] - Ask for the timetables again.
   * @returns {Promise<object[]>} The stations.
   */
  async function stations(force = false) {
    await check(force);
    return data().stations;
  }

  /**
   * @description The networks serving some stations: a zip is read only when
   * one of them has a line of it.
   * @param {string[]} codes - Station codes.
   * @returns {string[]} NETWORKS.
   */
  function networksOf(codes) {
    const all = data().stations ?? [];
    const lineIds = new Set(
      codes.flatMap((code) => all.find((station) => station.code === code)?.lines ?? []),
    );
    return networks.filter((network) => [...lineIds].some((id) => peekLineNetwork(id) === network));
  }

  /**
   * @description The network of a line id.
   * @param {string} id - "ld-ave", "10-c3".
   * @returns {string} NETWORKS.
   */
  const peekLineNetwork = (id) => (String(id).startsWith('ld-') ? NETWORKS.LD : NETWORKS.CER);

  /**
   * @description The timetable holding some stations, built from the zips when
   * the day, the zips or the stations changed. The stations already held stay.
   * @param {object[]} wanted - The stations (`code`).
   * @returns {Promise<object|null>} `{ from, to, codes, services, trips,
   * rows }`, null without a zip.
   */
  async function timetableOf(wanted) {
    await check();
    const current = now();
    const from = gtfsDate(current - DAY_MS, timeZone);
    const to = gtfsDate(current + 6 * DAY_MS, timeZone);
    const version = JSON.stringify(data().versions);
    const valid = timetable && timetable.from === from && timetable.version === version;
    if (valid && wanted.every((station) => timetable.codes.includes(station.code))) {
      return timetable;
    }
    building ??= (async () => {
      try {
        const codes = [
          ...new Set([...(valid ? timetable.codes : []), ...wanted.map((station) => station.code)]),
        ];
        const started = Date.now();
        const merged = { from, to, services: {}, trips: {}, rows: [] };
        let read = 0;
        for (const network of networksOf(codes)) {
          const zip = await readZip(network);
          if (!zip) {
            continue;
          }
          const gtfs = await readGtfs(zip, { stopIds: new Set(codes), from, to });
          Object.assign(merged.services, gtfs.timetable.services);
          Object.assign(merged.trips, gtfs.timetable.trips);
          merged.rows.push(...gtfs.timetable.rows);
          read += 1;
        }
        if (read === 0 && !networks.some((network) => zipCache[network])) {
          return null;
        }
        timetable = { ...merged, codes, version, builtAt: now() };
        logger?.info(
          `Renfe timetable of ${codes.length} station(s): ${timetable.rows.length} calls, ` +
            `${Date.now() - started} ms`,
        );
        return timetable;
      } finally {
        building = null;
      }
    })();
    const built = await building;
    if (!built && !timetable) {
      return null;
    }
    // Another station may have been asked while building.
    return wanted.every((station) => timetable?.codes.includes(station.code))
      ? timetable
      : timetableOf(wanted);
  }

  return {
    check,
    lines,
    stations,
    timetable: timetableOf,
    /**
     * @description A line known without reading anything.
     * @param {string} id - The line id ("10-c3").
     * @returns {object|null} The line.
     */
    peekLine: (id) => data().lines?.find((line) => line.id === String(id)) ?? null,
    /**
     * @description The line of a route, known without reading.
     * @param {string} routeId - A route id of the GTFS ("10T0001C1").
     * @returns {object|null} The line.
     */
    lineOfRoute: (routeId) =>
      data().lines?.find((line) => line.routeIds.includes(String(routeId))) ?? null,
    /**
     * @description Resolve a typed line.
     * @param {string} typed - The line as typed.
     * @param {object} [options] - `{ near }`: line ids that tell a núcleo.
     * @returns {Promise<object|null>} The line, null when unknown or ambiguous.
     */
    resolveLine: async (typed, options) => findLine(await lines(), typed, options),
    /**
     * @description Resolve a typed station.
     * @param {string} typed - A name or a code.
     * @returns {Promise<object|null>} The station.
     */
    resolveStation: async (typed) => findStation(await stations(), typed),
    /**
     * @description Search stations by name.
     * @param {string} query - Words of the name.
     * @returns {Promise<object[]>} The stations.
     */
    searchStations: async (query) => searchStations(await stations(), query),
    /**
     * @description What the diagnostic tells of the timetable.
     * @returns {object|null} Its window, stations and size.
     */
    describeTimetable: () =>
      timetable
        ? {
            from: timetable.from,
            to: timetable.to,
            stations: timetable.codes,
            calls: timetable.rows.length,
            builtAt: new Date(timetable.builtAt).toISOString(),
          }
        : null,
  };
}

export {
  NETWORKS,
  NUCLEOS,
  fold,
  slug,
  nucleoOf,
  nucleoName,
  linesOf,
  byLine,
  mergeStations,
  findLine,
  findStation,
  searchStations,
  gtfsDate,
  createNetwork,
};
