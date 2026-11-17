// -----------------------------------------------------------------------------
// Renfe integration: every handler, registered on a Gladys client.
//
// Brings the trains of Renfe — the long and medium distance (AVE, Avlo,
// Alvia, Intercity, Regional…) and the Cercanías and Rodalies of every núcleo
// — into Gladys, through the official open data of Renfe (GTFS and GTFS-RT,
// no key):
//   - devices (device.js): one per followed station — the three of the form
//     and the ones added with the "Add a station" button, with an optional
//     destination station and line — with the next train, the waits and the
//     delay; one per followed Cercanías line — up to six — with its traffic;
//   - scene triggers (events.js): departure soon, train late, train
//     cancelled, line disrupted, back to normal, new traffic message;
//   - scene actions: read the next trains of a station, read the traffic of a
//     line;
//   - dashboard widgets (widgets.js): departures, traffic.
//
// The open data have no push: the trip updates of the networks serving the
// followed stations are read in ONE request per network for every followed
// station, on the integration's own timer (every 30 s to 5 min, 1 min by
// default; every 10 min while no station announces anything in the next half
// hour, at night), the alerts every 5 min, never on a Gladys poll. The
// timetables (GTFS) are kept in /data and asked again daily (network.js); the
// trains come from them, corrected by the real time (departures.js).
// Transport: cloud only.
//
// index.js only creates the SDK client; the tests drive this module with the
// fake Gladys of the SDK (test/app.test.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import {
  normalizeConfig,
  readLanguage,
  parseLines,
  INTERNAL_KEYS,
  AUTO_LANGUAGE,
  MAX_ADDED_STATIONS,
  MAX_LINES,
} from './config.js';
import { createRenfeClient, NETWORKS } from './renfe-api.js';
import { createNetwork, fold, byLine } from './network.js';
import { createStore, DEFAULT_PATH } from './store.js';
import {
  buildPassages,
  indexTripUpdates,
  upcomingPassages,
  routeOf,
  trainLabel,
} from './departures.js';
import { parseTraffic, lineTraffic } from './traffic.js';
import {
  DEVICE_TYPES,
  codeKey,
  stationKey,
  followedName,
  idsOf,
  parseExternalId,
  buildStationDevice,
  buildStationStates,
  buildLineDevice,
  buildLineStates,
} from './device.js';
import {
  detectReminders,
  detectDelays,
  detectCancellations,
  detectLineChanges,
  reminderData,
  delayedData,
  cancelledData,
  lineEvent,
  nextDeparturesOutputs,
  lineTrafficOutputs,
  pick,
  TRIGGERS,
  NEXT_DEPARTURES_OUTPUTS,
  LINE_TRAFFIC_OUTPUTS,
} from './events.js';
import {
  WIDGETS,
  BOARD_COUNT,
  messageContent,
  readCount,
  buildDeparturesWidget,
  buildTrafficWidget,
} from './widgets.js';
import { defaultTimeZone, newDaySince, MINUTE_MS } from './time.js';
import { t, all, lineStateText, lineLabel, passageWhen, LANGUAGES } from './i18n.js';

const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  SEARCH_STATION: 'search_station',
  ADD_STATION: 'add_station',
  REMOVE_STATION: 'remove_station',
  LIST_STATIONS: 'list_stations',
  DIAGNOSTIC: 'diagnostic',
};
const SCENE_ACTIONS = {
  GET_NEXT_DEPARTURES: 'get_next_departures',
  GET_LINE_TRAFFIC: 'get_line_traffic',
};
// While no station announces anything in QUIET_HORIZON_MS (the night), the
// stations are read this often.
const IDLE_INTERVAL_MS = 10 * MINUTE_MS;
const QUIET_HORIZON_MS = 30 * MINUTE_MS;
const TRAFFIC_INTERVAL_MS = 5 * MINUTE_MS;
const REMINDER_TICK_MS = 30 * 1000;
// A widget or a scene action reuses a reading this fresh.
const SNAPSHOT_MAX_AGE_MS = 90 * 1000;
const BOARD_MAX_AGE_MS = 60 * 1000;
const TRAFFIC_MAX_AGE_MS = 3 * MINUTE_MS;
// A reading of the real time this recent replaces a refused one.
const REALTIME_STANDIN_MS = 3 * MINUTE_MS;
// Names that could not be resolved for a network reason are tried again.
const RESOLVE_RETRY_MS = 5 * MINUTE_MS;
const DIAGNOSTIC_CHUNK = 3000;
const SEARCH_ROUTES_MAX = 12;
const ACTION_TEXT_MAX = 1500;
const { version: VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * @description Cut a text of several lines at a line break, under a bound.
 * @param {string} text - The text.
 * @param {number} max - The bound.
 * @returns {string} The whole lines that fit, then "…".
 */
function clipLines(text, max) {
  if (text.length <= max) {
    return text;
  }
  const cut = text.lastIndexOf('\n', max - 2);
  return `${text.slice(0, cut > 0 ? cut : max - 2)}\n…`;
}

/**
 * @description The lines of one station, for "Find a station".
 * @param {string[]} names - The names of its lines.
 * @returns {string} "AVE, Alvia, C3 Madrid".
 */
function routesText(names) {
  if (names.length === 0) {
    return '–';
  }
  const shown = names.slice(0, SEARCH_ROUTES_MAX);
  return names.length > SEARCH_ROUTES_MAX ? `${shown.join(', ')}, …` : shown.join(', ');
}

/**
 * @description Register every handler of the integration on a Gladys client.
 * @param {object} gladys - A GladysIntegration (or the fake Gladys of the SDK).
 * @param {object} [options] - Options.
 * @param {Function} [options.fetch] - HTTP transport of the open data (tests).
 * @param {string} [options.baseUrl] - The feeds root (tests).
 * @param {object} [options.gtfsUrls] - `{ ld, cer }`: the GTFS zips (tests).
 * @param {Function} [options.sleep] - `(ms) => Promise`, the pause before
 * asking a busy feed again (tests).
 * @param {string} [options.storePath] - The file kept in /data (the GTFS zips
 * are kept next to it).
 * @param {Function} [options.now] - `() => number` in ms (tests).
 * @param {string} [options.timeZone] - IANA timezone of the times (TZ by default).
 * @param {boolean} [options.timers] - Arm the reading timers (false in tests).
 * @param {object} [options.logger] - Logger.
 * @returns {object} Handles for the tests.
 */
function createApp(
  gladys,
  {
    fetch: fetchFn,
    baseUrl,
    gtfsUrls,
    sleep,
    storePath = DEFAULT_PATH,
    now = () => Date.now(),
    timeZone = defaultTimeZone(),
    timers = true,
    logger = sdkLogger,
  } = {},
) {
  let config = normalizeConfig();
  // The raw values last read, internal keys included: the base of setConfig.
  let rawConfig = {};
  // The stations added with the buttons, one change at a time.
  let writingStations = Promise.resolve();
  // Language of the last widget request: the fallback of the texts Gladys does
  // not ask for in a language, when the `language` setting is `auto`. Spanish
  // until a widget is shown: the network serves Spain.
  let language = 'es';
  let createdDevices = new Set();
  // The followed stations and lines, resolved, and what Renfe does not know.
  let stations = [];
  // config.stations[i] -> its followed station (null when unknown), for
  // "List the stations".
  let entries = [];
  let lines = [];
  let notFound = [];
  // station key -> { passages, readAt } of its last reading; the last error
  // of the reading of the stations.
  const snapshots = new Map();
  // The last trip updates of the networks, indexed by trip, and the tracks of
  // the Cercanías trains.
  let realtime = { index: null, vehicles: null, networks: '', readAt: 0 };
  let stationsError = null;
  let stationsReadAt = 0;
  // The last reading of the traffic.
  let traffic = { data: null, readAt: 0, error: null };
  let trafficPending = null;
  // typed station -> { passages, readAt }, for the widgets of other stations.
  const boards = new Map();
  let resolveError = null;
  let lastStatus = null;
  let lastDiscovery = null;
  let stationTimer = null;
  let trafficTimer = null;
  let reminderTimer = null;
  let resolveTimer = null;
  let readingStations = null;
  let stopped = false;

  const api = createRenfeClient({
    now,
    ...(fetchFn ? { fetch: fetchFn } : {}),
    ...(baseUrl ? { feedsUrl: baseUrl } : {}),
    ...(gtfsUrls ? { gtfsUrls } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const store = createStore({ path: storePath, logger });
  const network = createNetwork({
    api,
    store,
    zipPaths: {
      [NETWORKS.LD]: join(dirname(storePath), 'renfe-ld.zip'),
      [NETWORKS.CER]: join(dirname(storePath), 'renfe-cer.zip'),
    },
    now,
    isNewDay: (since) => newDaySince(since, now(), timeZone),
    logger,
  });

  /**
   * @description Remember the language of a request, and store it when it changed.
   * @param {string} next - The language.
   */
  function rememberLanguage(next) {
    if (typeof next !== 'string' || !/^[a-z]{2}$/.test(next) || next === language) {
      return;
    }
    language = next;
    gladys
      .setConfig({ [INTERNAL_KEYS.language]: next })
      .catch((err) => logger.warn(`Unable to store the language: ${err.message}`));
  }

  /**
   * @description Language of the texts Gladys does not ask for in a language.
   * @returns {string} The language.
   */
  const textLanguage = () => (config.language === AUTO_LANGUAGE ? language : config.language);

  /**
   * @description The message of an error, for a user.
   * @param {Error} err - The error.
   * @param {string} lang - The language.
   * @returns {string} The message.
   */
  function errorText(err, lang) {
    return t(err?.kind === 'busy' ? 'errorBusy' : 'errorUnreachable', lang);
  }

  /**
   * @description Report the connection status, only when it changed.
   * @param {boolean} connected - Connected or not.
   * @param {object} message - The multi-language message.
   * @returns {Promise<void>}
   */
  async function reportStatus(connected, message) {
    const signature = JSON.stringify([connected, message]);
    if (signature === lastStatus) {
      return;
    }
    lastStatus = signature;
    try {
      await gladys.setConnectionStatus(connected, message);
    } catch (err) {
      lastStatus = null;
      logger.error('Unable to report the connection status', err);
    }
  }

  /**
   * @description Work out the connection status from the last readings.
   * @returns {Promise<void>}
   */
  async function refreshStatus() {
    const failing = (stations.length && stationsError ? 1 : 0) + (traffic.error ? 1 : 0);
    if (resolveError || failing >= (stations.length ? 2 : 1)) {
      const err = resolveError ?? traffic.error ?? stationsError;
      await reportStatus(
        false,
        all('statusUnreachable', {
          detail: String(err?.message ?? '').slice(0, 80),
          minutes: Math.round(Math.max(config.interval * 1000, MINUTE_MS) / MINUTE_MS),
        }),
      );
      return;
    }
    const unknown = notFound.length
      ? (l) => ` ${t('statusNotFound', l, { names: notFound.join(', ') })}`
      : () => '';
    if (stations.length + lines.length === 0) {
      await reportStatus(
        true,
        Object.fromEntries(LANGUAGES.map((l) => [l, `${t('statusNothing', l)}${unknown(l)}`])),
      );
      return;
    }
    const { interval } = config;
    await reportStatus(
      true,
      Object.fromEntries(
        LANGUAGES.map((l) => [
          l,
          `${t('statusConnected', l, { stations: stations.length, lines: lines.length, interval })}${unknown(l)}`,
        ]),
      ),
    );
  }

  /**
   * @description Refresh the list of the devices the user created.
   * @returns {Promise<void>}
   */
  async function refreshCreatedDevices() {
    try {
      const devices = await gladys.getDevices();
      createdDevices = new Set(devices.map((device) => device.external_id));
    } catch (err) {
      logger.warn(`Unable to read the devices: ${err.message}`);
    }
  }

  /**
   * @description Ask the open widgets to pull their content again.
   * @param {string[]} keys - The widget keys.
   */
  function refreshWidgets(keys) {
    for (const key of keys) {
      Promise.resolve(gladys.requestWidgetRefresh(key)).catch(() => {});
    }
  }

  /**
   * @description Publish scene events, one by one.
   * @param {Array<{ key: string, data: object }>} events - The events.
   * @returns {Promise<void>}
   */
  async function publishEvents(events) {
    for (const { key, data } of events) {
      logger.info(`${data.station_name ?? data.line_name}: ${key}`);
      try {
        await gladys.publishSceneEvent(key, data);
      } catch (err) {
        logger.warn(`Unable to fire ${key}: ${err.message}`);
      }
    }
  }

  // --- Stations and lines ------------------------------------------------------------

  /**
   * @description Resolve one station of the configuration.
   * @param {object} entry - `{ slot, added, station, destination, line }`.
   * @returns {Promise<object>} The followed station, or `{ unknown }`: the
   * typed station or line Renfe does not know (or a name of several).
   */
  async function resolveEntry(entry) {
    const station = await network.resolveStation(entry.station);
    if (!station) {
      return { unknown: entry.station };
    }
    const destination = entry.destination ? await network.resolveStation(entry.destination) : null;
    if (entry.destination && (!destination || destination.code === station.code)) {
      return { unknown: entry.destination };
    }
    // "C1" alone: the one calling at the station.
    const line = entry.line ? await network.resolveLine(entry.line, { near: station.lines }) : null;
    if (entry.line && !line) {
      return { unknown: entry.line };
    }
    const key = stationKey(station, destination, line);
    const followed = {
      slot: entry.slot,
      added: entry.added ?? null,
      station,
      destination,
      line,
      key,
    };
    return {
      ...followed,
      name: followedName(followed),
      deviceId: idsOf(gladys, DEVICE_TYPES.STATION, key).device,
    };
  }

  /**
   * @description Resolve the configured stations and lines.
   * @returns {Promise<void>}
   */
  async function resolveConfig() {
    clearTimeout(resolveTimer);
    const resolvedStations = [];
    const resolvedEntries = [];
    const resolvedLines = [];
    const unknown = [];
    try {
      for (const entry of config.stations) {
        const followed = await resolveEntry(entry);
        if (followed.unknown) {
          unknown.push(followed.unknown);
          resolvedEntries.push(null);
          continue;
        }
        const known = resolvedStations.find((other) => other.key === followed.key);
        if (!known) {
          resolvedStations.push(followed);
        }
        resolvedEntries.push(known ?? followed);
      }
      // A line typed without its núcleo: the one of the followed stations.
      const near = resolvedStations.flatMap((followed) => [
        ...followed.station.lines,
        ...(followed.destination?.lines ?? []),
      ]);
      for (const typed of config.lines) {
        const line = await network.resolveLine(typed, { near });
        if (!line) {
          unknown.push(typed);
        } else if (!resolvedLines.some((known) => known.id === line.id)) {
          resolvedLines.push({
            ...line,
            deviceId: idsOf(gladys, DEVICE_TYPES.LINE, line.id).device,
          });
        }
      }
      resolveError = null;
    } catch (err) {
      // Keep what was resolved before; try again later.
      logger.warn(`Unable to read the timetables (${err.kind ?? 'error'}): ${err.message}`);
      resolveError = err;
      if (timers && !stopped) {
        resolveTimer = setTimeout(() => {
          applyConfig().catch(() => {});
        }, RESOLVE_RETRY_MS);
        resolveTimer.unref?.();
      }
      return;
    }
    stations = resolvedStations;
    entries = resolvedEntries;
    lines = resolvedLines;
    notFound = unknown;
    for (const key of [...snapshots.keys()]) {
      if (!stations.some((followed) => followed.key === key)) {
        snapshots.delete(key);
      }
    }
  }

  /**
   * @description Offer a device per station and per line on the Discovery screen,
   * when they changed.
   * @param {boolean} [force] - Publish even when unchanged.
   * @returns {Promise<number>} How many devices were offered.
   */
  async function publishDiscoveredDevices(force = false) {
    const lang = textLanguage();
    const devices = [
      ...stations.map((followed) => buildStationDevice(gladys, followed, lang)),
      ...lines.map((line) => buildLineDevice(gladys, line, lang)),
    ];
    const signature = JSON.stringify(devices);
    if (force || signature !== lastDiscovery) {
      await gladys.publishDiscoveredDevices(devices);
      lastDiscovery = signature;
    }
    return devices.length;
  }

  // --- Reading the stations ---------------------------------------------------------

  /**
   * @description Publish the states of a station, when its device exists.
   * @param {object} followed - The followed station.
   * @returns {Promise<void>}
   */
  async function publishStationStates(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot || !createdDevices.has(followed.deviceId)) {
      return;
    }
    await gladys
      .publishChangedStates(
        buildStationStates(gladys, followed, snapshot.passages, {
          language: textLanguage(),
          now: now(),
          timeZone,
        }),
      )
      .catch((err) =>
        logger.warn(`Unable to publish the states of ${followed.name}: ${err.message}`),
      );
  }

  /**
   * @description The reminders due on the last reading of a station.
   * @param {object} followed - The followed station.
   * @returns {object[]} The events.
   */
  function reminderEvents(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot) {
      return [];
    }
    const { due, fired } = detectReminders({
      passages: snapshot.passages,
      fired: store.data.seen.reminders[followed.key],
      now: now(),
    });
    store.data.seen.reminders[followed.key] = fired;
    return due.map(({ passage, mark }) => ({
      key: TRIGGERS.DEPARTURE_SOON,
      data: reminderData(followed, passage, mark, { language: textLanguage(), timeZone }),
    }));
  }

  /**
   * @description The delays not reported yet on the last reading of a station.
   * @param {object} followed - The followed station.
   * @returns {object[]} The events.
   */
  function delayEvents(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot) {
      return [];
    }
    store.data.seen.delayed ??= {};
    const { due, known } = detectDelays({
      passages: snapshot.passages,
      known: store.data.seen.delayed[followed.key],
      now: now(),
    });
    store.data.seen.delayed[followed.key] = known;
    return due.map(({ passage, mark }) => ({
      key: TRIGGERS.DEPARTURE_DELAYED,
      data: delayedData(followed, passage, mark, { language: textLanguage(), timeZone }),
    }));
  }

  /**
   * @description The cancellations not reported yet on the last reading of a
   * station.
   * @param {object} followed - The followed station.
   * @returns {object[]} The events.
   */
  function cancellationEvents(followed) {
    const snapshot = snapshots.get(followed.key);
    if (!snapshot) {
      return [];
    }
    store.data.seen.cancelled ??= {};
    const { due, known } = detectCancellations({
      passages: snapshot.passages,
      known: store.data.seen.cancelled[followed.key],
      now: now(),
    });
    store.data.seen.cancelled[followed.key] = known;
    return due.map((passage) => ({
      key: TRIGGERS.DEPARTURE_CANCELLED,
      data: cancelledData(followed, passage, { language: textLanguage(), timeZone }),
    }));
  }

  /**
   * @description Every train event due on the last reading of a station.
   * @param {object} followed - The followed station.
   * @returns {object[]} The events.
   */
  const trainEvents = (followed) => [
    ...cancellationEvents(followed),
    ...delayEvents(followed),
    ...reminderEvents(followed),
  ];

  /**
   * @description The trains of a followed (or typed) station.
   * @param {object} followed - `{ station, destination, line }`.
   * @param {object|null} timetable - network.timetable().
   * @param {object|null} live - `{ index, vehicles }` (none: the timetable only).
   * @returns {object[]} Its trains.
   */
  function passagesOf({ station, destination = null, line = null }, timetable, live) {
    return buildPassages({
      timetable,
      station,
      destination,
      line,
      realtime: live?.index ?? null,
      vehicles: live?.vehicles ?? null,
      now: now(),
      lineOfRoute: network.lineOfRoute,
    });
  }

  /**
   * @description The networks serving some followed stations.
   * @param {object[]} list - The followed stations.
   * @returns {string[]} NETWORKS, in a fixed order.
   */
  function networksOf(list) {
    const ids = new Set(
      list.flatMap((followed) => [
        ...followed.station.lines,
        ...(followed.destination?.lines ?? []),
      ]),
    );
    const wanted = new Set(
      [...ids].map((id) => (id.startsWith('ld-') ? NETWORKS.LD : NETWORKS.CER)),
    );
    return [NETWORKS.LD, NETWORKS.CER].filter((name) => wanted.has(name));
  }

  /**
   * @description Read the trip updates of some networks (one request each),
   * and the tracks of the Cercanías trains.
   * @param {string[]} names - NETWORKS.
   * @returns {Promise<object>} `{ index, vehicles }`.
   */
  async function readRealtime(names) {
    const feeds = [];
    for (const name of names) {
      feeds.push(await api.tripUpdates(name));
    }
    let vehicles = null;
    if (names.includes(NETWORKS.CER)) {
      // The tracks are a bonus: their absence never fails a reading.
      vehicles = await api.vehicles().catch((err) => {
        logger.debug?.(`Renfe vehicles not read (${err.kind ?? 'error'}): ${err.message}`);
        return realtime.vehicles;
      });
    }
    realtime = {
      index: indexTripUpdates(...feeds),
      vehicles,
      networks: names.join(','),
      readAt: now(),
    };
    return realtime;
  }

  /**
   * @description The last real time, when it covers some networks.
   * @param {string[]} names - NETWORKS.
   * @returns {object|null} `{ index, vehicles }`, null when it does not.
   */
  const realtimeOf = (names) =>
    realtime.index && names.every((name) => realtime.networks.split(',').includes(name))
      ? realtime
      : null;

  /**
   * @description What follows a reading of a station: events, states.
   * @param {object} followed - The followed station.
   * @returns {Promise<void>}
   */
  async function digestStation(followed) {
    const events = gladys.connected !== false ? trainEvents(followed) : [];
    await store.save();
    await publishEvents(events);
    await publishStationStates(followed);
  }

  /**
   * @description Read some followed stations now: their timetable, and the
   * trip updates of their networks in one request each. Without the real
   * time, the trains are the timetable only; the error is thrown once they
   * are set. Without a timetable, the stations keep their last reading.
   * @param {object[]} list - The followed stations.
   * @returns {Promise<void>}
   */
  async function readFollowed(list) {
    let failure = null;
    let timetable = null;
    try {
      timetable = await network.timetable(
        list.flatMap((followed) => [
          followed.station,
          ...(followed.destination ? [followed.destination] : []),
        ]),
      );
    } catch (err) {
      failure = err;
    }
    // Every followed station in the request: the next reading serves them all.
    const names = networksOf(stations.length ? [...new Set([...stations, ...list])] : list);
    let live = null;
    try {
      live = await readRealtime(names);
    } catch (err) {
      // A recent reading stands in for a refused one.
      const last = realtimeOf(names);
      if (last && now() - realtime.readAt <= REALTIME_STANDIN_MS) {
        live = last;
        logger.debug?.(`Renfe real time not read (${err.kind ?? 'error'}): the last one is used`);
      } else {
        failure ??= err;
      }
    }
    stationsError = failure;
    if (!timetable) {
      throw failure ?? new Error('no timetable');
    }
    const readAt = now();
    for (const followed of list) {
      snapshots.set(followed.key, { passages: passagesOf(followed, timetable, live), readAt });
    }
    stationsReadAt = readAt;
    for (const followed of list) {
      await digestStation(followed);
    }
    if (failure) {
      throw failure;
    }
  }

  /**
   * @description Whether the stations are due for a reading.
   * @returns {boolean} True when due.
   */
  function stationsDue() {
    if (stationsError || stations.some((followed) => !snapshots.has(followed.key))) {
      return true;
    }
    const age = now() - stationsReadAt;
    // At night no station announces anything soon: read them less often.
    const quiet = stations.every((followed) =>
      upcomingPassages(snapshots.get(followed.key).passages, now()).every(
        (passage) => passage.at - now() > QUIET_HORIZON_MS,
      ),
    );
    return age >= (quiet ? IDLE_INTERVAL_MS : config.interval * 1000) - 1000;
  }

  /**
   * @description Read every followed station when due (one reading at a time).
   * @param {object} [options] - `{ force }`: read even when not due.
   * @returns {Promise<void>}
   */
  function readStations({ force = false } = {}) {
    if (!readingStations) {
      readingStations = (async () => {
        if (stations.length > 0 && (force || stationsDue())) {
          try {
            await readFollowed(stations);
            refreshWidgets([WIDGETS.DEPARTURES]);
          } catch (err) {
            logger.warn(`Renfe stations (${err.kind ?? 'error'}): ${err.message}`);
          }
        }
        await refreshStatus();
      })().finally(() => {
        readingStations = null;
      });
    }
    return readingStations;
  }

  /**
   * @description The snapshots of followed stations, read again (together)
   * when older than `maxAgeMs`.
   * @param {object[]} list - The followed stations.
   * @param {number} maxAgeMs - The freshness wanted.
   * @returns {Promise<object[]>} Their snapshots, in the same order.
   */
  async function snapshotsOf(list, maxAgeMs) {
    const stale = list.filter((followed) => {
      const snapshot = snapshots.get(followed.key);
      return !snapshot || now() - snapshot.readAt > maxAgeMs;
    });
    if (stale.length > 0) {
      await readFollowed(stale);
    }
    return list.map((followed) => snapshots.get(followed.key));
  }

  /**
   * @description Check the reminders on the last readings (between readings).
   * @returns {Promise<void>}
   */
  async function checkReminders() {
    // Disconnected, the event would be lost while marked as fired.
    if (gladys.connected === false) {
      return;
    }
    const events = stations.flatMap((followed) => trainEvents(followed));
    if (events.length) {
      await store.save();
      await publishEvents(events);
    }
  }

  // --- Reading the traffic -----------------------------------------------------------

  /**
   * @description Publish what a traffic reading changed: events of the
   * followed lines, states of the line devices.
   * @returns {Promise<void>}
   */
  async function digestTraffic() {
    const current = now();
    if (gladys.connected !== false) {
      const lineChanges = detectLineChanges({
        lines,
        traffic: traffic.data,
        seen: store.data.seen.lines,
        now: current,
      });
      store.data.seen.lines = lineChanges.seen;
      await store.save();
      await publishEvents(
        lineChanges.changes.map((change) =>
          lineEvent(change, { language: textLanguage(), timeZone }),
        ),
      );
    }
    const states = lines
      .filter((line) => createdDevices.has(line.deviceId))
      .flatMap((line) =>
        buildLineStates(gladys, line, lineTraffic(traffic.data, line.id, current), textLanguage()),
      );
    if (states.length > 0) {
      await gladys
        .publishChangedStates(states)
        .catch((err) => logger.warn(`Unable to publish the traffic states: ${err.message}`));
    }
    refreshWidgets([WIDGETS.TRAFFIC]);
  }

  /**
   * @description Read the traffic now (one reading at a time).
   * @returns {Promise<object>} `{ data, readAt }`.
   */
  function readTrafficNow() {
    if (!trafficPending) {
      trafficPending = (async () => {
        try {
          const feed = await api.alerts();
          traffic = {
            data: parseTraffic(feed, { lineOfRoute: network.lineOfRoute }),
            readAt: now(),
            error: null,
          };
          await digestTraffic();
          return traffic;
        } catch (err) {
          traffic = { ...traffic, error: err };
          throw err;
        } finally {
          trafficPending = null;
        }
      })();
    }
    return trafficPending;
  }

  /**
   * @description The traffic, read again when older than `maxAgeMs`.
   * @param {number} maxAgeMs - The freshness wanted.
   * @returns {Promise<object>} `{ data, readAt }`.
   */
  async function trafficOf(maxAgeMs) {
    if (traffic.data && now() - traffic.readAt <= maxAgeMs) {
      return traffic;
    }
    return readTrafficNow();
  }

  /**
   * @description The regular reading of the traffic: always, the traffic
   * widget shows the lines of the followed stations without a followed line.
   * @returns {Promise<void>}
   */
  async function trafficTick() {
    await readTrafficNow().catch((err) =>
      logger.warn(`Renfe traffic (${err.kind ?? 'error'}): ${err.message}`),
    );
    await refreshStatus();
  }

  // --- Timers ------------------------------------------------------------------------

  /**
   * @description (Re)arm the timers.
   */
  function schedule() {
    clearInterval(stationTimer);
    clearInterval(trafficTimer);
    clearInterval(reminderTimer);
    if (!timers || stopped) {
      return;
    }
    // A short tick: stationsDue() decides whether the stations are due.
    stationTimer = setInterval(
      () => {
        readStations().catch((err) => logger.error('Stations', err));
      },
      Math.min(config.interval * 1000, 30000),
    );
    trafficTimer = setInterval(() => {
      trafficTick().catch((err) => logger.error('Traffic', err));
    }, TRAFFIC_INTERVAL_MS);
    reminderTimer = setInterval(() => {
      checkReminders().catch((err) => logger.warn(`Reminders: ${err.message}`));
    }, REMINDER_TICK_MS);
    [stationTimer, trafficTimer, reminderTimer].forEach((timer) => timer.unref?.());
  }

  /**
   * @description Resolve the configuration, offer the devices, read everything.
   * @returns {Promise<void>}
   */
  async function applyConfig() {
    await resolveConfig();
    logger.info(
      `${stations.length} station(s): ${stations.map((followed) => followed.name).join(', ') || 'none'}; ` +
        `${lines.length} line(s): ${lines.map((line) => line.name).join(', ') || 'none'}` +
        (notFound.length ? `; unknown: ${notFound.join(', ')}` : ''),
    );
    await publishDiscoveredDevices().catch((err) =>
      logger.warn(`Unable to offer the devices: ${err.message}`),
    );
    await readStations({ force: true });
    await trafficTick();
    await refreshStatus();
    schedule();
  }

  // --- Dashboard widgets -------------------------------------------------------------

  /**
   * @description What a widget or a scene action targets, by device external id.
   * @param {unknown} externalId - The `source: "devices"` value.
   * @param {string} type - DEVICE_TYPES.
   * @returns {object|null} The followed station or line, the first one by default.
   */
  function target(externalId, type) {
    const parsed = parseExternalId(externalId);
    const list = type === DEVICE_TYPES.STATION ? stations : lines;
    const keyOf = (item) => (type === DEVICE_TYPES.STATION ? item.key : codeKey(item.id));
    const found = parsed?.type === type ? list.find((item) => keyOf(item) === parsed.key) : null;
    return found ?? list[0] ?? null;
  }

  /**
   * @description The trains of a station typed in a widget.
   * @param {string} typed - The station.
   * @param {string} typedLine - Its optional line.
   * @param {string} lang - The language.
   * @returns {Promise<object>} `{ title, passages, readAt }` or `{ message }`.
   */
  async function typedBoard(typed, typedLine, lang) {
    const station = await network.resolveStation(typed);
    if (!station) {
      return { message: t('statusNotFound', lang, { names: typed.slice(0, 60) }) };
    }
    const line = typedLine ? await network.resolveLine(typedLine, { near: station.lines }) : null;
    if (typedLine && !line) {
      return { message: t('statusNotFound', lang, { names: typedLine.slice(0, 60) }) };
    }
    const key = stationKey(station, null, line);
    let board = boards.get(key);
    if (!board || now() - board.readAt > BOARD_MAX_AGE_MS) {
      const timetable = await network.timetable([station]);
      const names = networksOf([{ station }]);
      let live = realtimeOf(names);
      if (!live || now() - realtime.readAt > BOARD_MAX_AGE_MS) {
        live = await readRealtime(names).catch(() => realtimeOf(names));
      }
      board = { readAt: now(), passages: passagesOf({ station, line }, timetable, live) };
      boards.set(key, board);
    }
    const title = followedName({ station, destination: null, line });
    return { title, ...board };
  }

  /**
   * @description The followed stations chosen in the `stations` setting of a
   * widget, grouped by station: devices of one station (one per destination
   * and line) make one board, their routes merged.
   * @param {unknown} raw - The `multi_select` value: device external ids.
   * @returns {Promise<object[]>} `[{ title, label, passages, readAt }]`,
   * in the order chosen; empty when no chosen device is followed any more.
   */
  async function followedBoards(raw) {
    const ids = Array.isArray(raw) ? raw : [];
    const groups = new Map();
    for (const id of ids) {
      const parsed = parseExternalId(id);
      const followed =
        parsed?.type === DEVICE_TYPES.STATION
          ? stations.find((item) => item.key === parsed.key)
          : null;
      if (!followed) {
        continue;
      }
      const group = followed.station.code;
      const members = groups.get(group) ?? [];
      if (!members.includes(followed)) {
        groups.set(group, [...members, followed]);
      }
    }
    // Every chosen device in one reading when they need a new one.
    await snapshotsOf([...groups.values()].flat(), SNAPSHOT_MAX_AGE_MS);
    const result = [];
    for (const members of groups.values()) {
      const read = members.map((followed) => snapshots.get(followed.key));
      // A train of two chosen devices (every train and one destination) once.
      const passages = new Map();
      for (const passage of read.flatMap((snapshot) => snapshot.passages)) {
        passages.set(`${routeOf(passage)}|${passage.trip}`, passage);
      }
      const [first] = members;
      result.push({
        title: members.length > 1 ? first.station.name : first.name,
        label: first.station.name,
        passages: [...passages.values()].sort((a, b) => a.at - b.at),
        readAt: Math.min(...read.map((snapshot) => snapshot.readAt)),
      });
    }
    return result;
  }

  gladys.onWidgetGet(WIDGETS.DEPARTURES, async ({ settings = {}, language: lang }) => {
    rememberLanguage(lang);
    const count = readCount(settings.count, BOARD_COUNT);
    const typed = typeof settings.station_name === 'string' ? settings.station_name.trim() : '';
    const typedLine = typeof settings.line === 'string' ? settings.line.trim() : '';
    try {
      let board;
      if (typed) {
        board = await typedBoard(typed, typedLine, lang);
        if (board.message) {
          return messageContent(board.message);
        }
      } else {
        const several = await followedBoards(settings.stations);
        if (several.length > 1) {
          board = { boards: several };
        } else if (several.length === 1) {
          board = several[0];
        } else {
          const followed = target(settings.station, DEVICE_TYPES.STATION);
          if (!followed) {
            return messageContent(t('widgetNoStation', lang));
          }
          const [snapshot] = await snapshotsOf([followed], SNAPSHOT_MAX_AGE_MS);
          board = { title: followed.name, ...snapshot };
        }
      }
      return buildDeparturesWidget({ ...board, count, language: lang, now: now(), timeZone });
    } catch (err) {
      logger.warn(`Widget: unable to read the trains: ${err.message}`);
      return messageContent(errorText(err, lang), 60);
    }
  });

  gladys.onWidgetGet(WIDGETS.TRAFFIC, async ({ settings = {}, language: lang }) => {
    rememberLanguage(lang);
    try {
      let wanted = lines;
      const typed = parseLines(settings.lines);
      if (typed.length > 0) {
        wanted = [];
        const near = stations.flatMap((followed) => followed.station.lines);
        for (const entry of typed) {
          const line = await network.resolveLine(entry, { near });
          if (!line) {
            return messageContent(t('statusNotFound', lang, { names: entry.slice(0, 60) }));
          }
          wanted.push(line);
        }
      }
      if (wanted.length === 0) {
        // Nothing followed nor typed: the Cercanías lines of the followed stations.
        const ids = new Set(stations.flatMap((followed) => followed.station.lines));
        wanted = (await network.lines())
          .filter((line) => line.network === NETWORKS.CER && ids.has(line.id))
          .sort(byLine)
          .slice(0, MAX_LINES);
      }
      if (wanted.length === 0) {
        return messageContent(t('widgetNoLine', lang));
      }
      const current = await trafficOf(TRAFFIC_MAX_AGE_MS);
      return buildTrafficWidget({
        lines: wanted.map((line) => ({
          line,
          traffic: lineTraffic(current.data, line.id, now()),
        })),
        readAt: current.readAt,
        language: lang,
        now: now(),
        timeZone,
      });
    } catch (err) {
      logger.warn(`Widget: unable to read the traffic: ${err.message}`);
      return messageContent(errorText(err, lang), 60);
    }
  });

  // --- Scene actions -----------------------------------------------------------------
  gladys.onSceneAction(SCENE_ACTIONS.GET_NEXT_DEPARTURES, async (fields = {}) => {
    const followed = target(fields.station, DEVICE_TYPES.STATION);
    if (!followed) {
      throw new Error('No Renfe station is followed');
    }
    const [snapshot] = await snapshotsOf([followed], SNAPSHOT_MAX_AGE_MS);
    return pick(
      nextDeparturesOutputs({
        followed,
        passages: snapshot.passages,
        now: now(),
        language: textLanguage(),
        timeZone,
      }),
      NEXT_DEPARTURES_OUTPUTS,
    );
  });

  gladys.onSceneAction(SCENE_ACTIONS.GET_LINE_TRAFFIC, async (fields = {}) => {
    const line = target(fields.line, DEVICE_TYPES.LINE);
    if (!line) {
      throw new Error('No Renfe line is followed');
    }
    const current = await trafficOf(SNAPSHOT_MAX_AGE_MS);
    return pick(
      lineTrafficOutputs({
        line,
        traffic: lineTraffic(current.data, line.id, now()),
        language: textLanguage(),
      }),
      LINE_TRAFFIC_OUTPUTS,
    );
  });

  // --- Configuration screen actions --------------------------------------------------
  gladys.onAction(ACTIONS.TEST_CONNECTION, async () => {
    const messages = [];
    try {
      const known = await network.lines(true);
      const knownStations = await network.stations();
      messages.push(all('testNetworkOk', { lines: known.length, stations: knownStations.length }));
    } catch (err) {
      resolveError = err;
      await refreshStatus();
      return all('testTrafficError', (l) => ({ error: errorText(err, l) }));
    }
    await resolveConfig();
    await publishDiscoveredDevices().catch(() => {});
    let stationsFailure = null;
    if (stations.length > 0) {
      try {
        await readFollowed(stations);
      } catch (err) {
        stationsFailure = err;
      }
    }
    for (const followed of stations) {
      const snapshot = snapshots.get(followed.key);
      if (!snapshot || (stationsFailure && now() - snapshot.readAt > SNAPSHOT_MAX_AGE_MS)) {
        messages.push(
          all('testStationError', (l) => ({
            station: followed.name,
            error: errorText(stationsFailure, l),
          })),
        );
        continue;
      }
      const [first] = upcomingPassages(snapshot.passages, now());
      messages.push(
        all('testStation', (l) => ({
          station: followed.name,
          count: snapshot.passages.length,
          next: first
            ? `${trainLabel(first)} ${passageWhen(first, { language: l, now: now(), timeZone })}`
            : '–',
        })),
      );
    }
    try {
      const current = await readTrafficNow();
      lines.forEach((line) => {
        const { state } = lineTraffic(current.data, line.id, now());
        messages.push(
          all('testLine', (l) => ({ line: lineLabel(line), state: lineStateText(state, l) })),
        );
      });
    } catch (err) {
      messages.push(all('testTrafficError', (l) => ({ error: errorText(err, l) })));
    }
    notFound.forEach((name) => messages.push(all('unknownEntry', { name })));
    refreshWidgets(Object.values(WIDGETS));
    await refreshStatus();
    return Object.fromEntries(
      LANGUAGES.map((l) => [
        l,
        messages
          .map((entry) => entry[l])
          .join(' · ')
          .slice(0, 1000),
      ]),
    );
  });

  gladys.onAction(ACTIONS.SEARCH_STATION, async (fields = {}) => {
    const query = typeof fields.query === 'string' ? fields.query.trim() : '';
    if (query.length < 2) {
      return all('searchTooShort');
    }
    const found = await network.searchStations(query);
    if (found.length === 0) {
      return all('searchNone', { query: query.slice(0, 60) });
    }
    const blocks = found.map((station) => {
      const names = station.lines
        .map((id) => network.peekLine(id))
        .filter(Boolean)
        .sort(byLine)
        .map((line) =>
          line.network === NETWORKS.CER ? `${line.name} ${line.nucleoName}` : line.name,
        );
      return `• ${station.name} [${station.code}] → ${routesText(names)}`;
    });
    return all('searchFound', { list: clipLines(blocks.join('\n'), ACTION_TEXT_MAX - 300) });
  });

  // --- Stations added with the buttons ----------------------------------------------

  const field = (value) => (typeof value === 'string' ? value.trim() : '');

  /**
   * @description Change the added stations, one change after the other: two
   * quick buttons never lose a station. Applied in memory once Gladys saved it.
   * @param {Function} change - `(added) => Promise<{ next?, message }>`: the new
   * list (none: nothing to save) and the answer, or a function of nothing
   * giving it once the stations are read.
   * @returns {Promise<object>} The answer.
   */
  function changeAddedStations(change) {
    const run = writingStations.then(async () => {
      const { next, message } = await change(config.addedStations);
      if (next) {
        await gladys.setConfig({ [INTERNAL_KEYS.addedStations]: next });
        rawConfig = { ...rawConfig, [INTERNAL_KEYS.addedStations]: next };
        config = normalizeConfig(rawConfig);
        await resolveConfig();
        await publishDiscoveredDevices().catch((err) =>
          logger.warn(`Unable to offer the devices: ${err.message}`),
        );
        // Only the new station is due: it has no reading yet.
        await readStations();
      }
      return typeof message === 'function' ? message() : message;
    });
    writingStations = run.catch(() => {});
    return run;
  }

  /**
   * @description How a station of the configuration reads in "List the stations".
   * @param {object} entry - A station of `config.stations`.
   * @param {number} index - Its position.
   * @param {string} lang - The language.
   * @returns {string} "2. Madrid-Atocha Cercanías → Aranjuez (formulario, estación 2)".
   */
  function entryText(entry, index, lang) {
    const followed = entries[index];
    const typed = [entry.station, entry.destination && `→ ${entry.destination}`, entry.line]
      .filter(Boolean)
      .join(' ');
    const notes = [
      entry.slot ? t('stationFromForm', lang, { slot: entry.slot }) : '',
      entries.length && !followed ? t('stationUnknownMark', lang) : '',
    ].filter(Boolean);
    const name = followed?.name ?? typed;
    return `${index + 1}. ${name}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  }

  gladys.onAction(ACTIONS.ADD_STATION, async (fields = {}) => {
    const entry = {
      station: field(fields.station),
      destination: field(fields.destination),
      line: field(fields.line),
    };
    if (entry.station.length < 2) {
      return all('searchTooShort');
    }
    return changeAddedStations(async (added) => {
      if (added.length >= MAX_ADDED_STATIONS) {
        return { message: all('stationsFull', { max: MAX_ADDED_STATIONS }) };
      }
      let followed;
      try {
        followed = await resolveEntry(entry);
      } catch (err) {
        return { message: all('testTrafficError', (l) => ({ error: errorText(err, l) })) };
      }
      if (followed.unknown) {
        return { message: all('statusNotFound', { names: followed.unknown.slice(0, 60) }) };
      }
      if (stations.some((other) => other.key === followed.key)) {
        return { message: all('stationAlreadyFollowed', { name: followed.name }) };
      }
      // Stored as resolved: the codes of the stations and the id of the line.
      const stored = {
        station: followed.station.code,
        destination: followed.destination?.code ?? '',
        line: followed.line?.id ?? '',
      };
      logger.info(`Station added: ${followed.name}`);
      return {
        next: [...added, stored],
        message: () => all('stationAdded', { name: followed.name, count: stations.length }),
      };
    });
  });

  gladys.onAction(ACTIONS.REMOVE_STATION, async (fields = {}) => {
    const query = field(fields.station);
    if (!query) {
      return all('stationRemoveUnknown', { query });
    }
    return changeAddedStations(async (added) => {
      const number =
        /^#?\d+$/.test(query) && query.length <= 3 ? Number(query.replace('#', '')) : null;
      let found;
      if (number !== null) {
        found = config.stations[number - 1] ? [number - 1] : [];
      } else {
        const wanted = fold(query);
        found = config.stations
          .map((entry, index) => ({ entry, index, followed: entries[index] }))
          .filter(
            ({ entry, followed }) =>
              fold(entry.station) === wanted ||
              (followed &&
                (fold(followed.name) === wanted || fold(followed.station.name) === wanted)),
          )
          .map(({ index }) => index);
        // The same name in the form and in the added stations: the added one.
        const fromButtons = found.filter((index) => !config.stations[index].slot);
        found = fromButtons.length > 0 ? fromButtons : found;
      }
      if (found.length === 0) {
        return { message: all('stationRemoveUnknown', { query: query.slice(0, 60) }) };
      }
      if (found.length > 1) {
        return { message: all('stationRemoveAmbiguous', { query: query.slice(0, 60) }) };
      }
      const entry = config.stations[found[0]];
      const name = entries[found[0]]?.name ?? entry.station;
      if (entry.slot) {
        return { message: all('stationInForm', { name, slot: entry.slot }) };
      }
      logger.info(`Station removed: ${name}`);
      return {
        next: added.filter((_, index) => index !== entry.added - 1),
        message: all('stationRemoved', { name }),
      };
    });
  });

  gladys.onAction(ACTIONS.LIST_STATIONS, async () => {
    if (config.stations.length === 0) {
      return all('stationsNone');
    }
    return all('stationsList', (l) => ({
      count: config.stations.length,
      list: clipLines(
        config.stations.map((entry, index) => entryText(entry, index, l)).join('\n'),
        ACTION_TEXT_MAX - 100,
      ),
    }));
  });

  gladys.onAction(ACTIONS.DIAGNOSTIC, async () => {
    const report = {
      version: VERSION,
      timeZone: timeZone ?? null,
      interval: config.interval,
      language: config.language,
      stations: stations.map((followed) => {
        const snapshot = snapshots.get(followed.key);
        return {
          slot: followed.slot,
          added: followed.added,
          key: followed.key,
          station: { code: followed.station.code, name: followed.station.name },
          destination: followed.destination?.code ?? null,
          line: followed.line?.id ?? null,
          created: createdDevices.has(followed.deviceId),
          readAt: snapshot ? new Date(snapshot.readAt).toISOString() : null,
          trains: snapshot?.passages
            .slice(0, 6)
            .map(
              (p) =>
                `${trainLabel(p)}>${p.destination} ${new Date(p.at).toISOString().slice(11, 16)}Z` +
                `${p.cancelled ? ' cancelled' : p.realtime ? ` +${p.delay}` : ' sched'}` +
                `${p.track ? ` v${p.track}` : ''}`,
            ),
        };
      }),
      stationsError: stationsError?.message ?? null,
      lines: lines.map((line) => {
        const current = traffic.data ? lineTraffic(traffic.data, line.id, now()) : null;
        return {
          id: line.id,
          name: lineLabel(line),
          created: createdDevices.has(line.deviceId),
          state: current?.state ?? null,
          messages: current?.messages.length ?? null,
        };
      }),
      notFound,
      traffic: {
        readAt: traffic.readAt ? new Date(traffic.readAt).toISOString() : null,
        messages: traffic.data?.messages.length ?? null,
        error: traffic.error?.message ?? null,
      },
      realtime: {
        readAt: realtime.readAt ? new Date(realtime.readAt).toISOString() : null,
        networks: realtime.networks || null,
        trips: realtime.index?.size ?? null,
        vehicles: realtime.vehicles?.size ?? null,
      },
      network: {
        lines: store.data.network.lines?.length ?? null,
        stations: store.data.network.stations?.length ?? null,
        versions: store.data.network.versions ?? null,
        checkedAt: store.data.network.checkedAt
          ? new Date(store.data.network.checkedAt).toISOString()
          : null,
        timetable: network.describeTimetable(),
      },
      resolveError: resolveError?.message ?? null,
      requests: api.requests,
    };
    const json = JSON.stringify(report);
    const count = Math.max(1, Math.ceil(json.length / DIAGNOSTIC_CHUNK));
    for (let chunk = 0; chunk < count; chunk += 1) {
      logger.info(
        `Renfe diagnostic ${chunk + 1}/${count}: ${json.slice(chunk * DIAGNOSTIC_CHUNK, (chunk + 1) * DIAGNOSTIC_CHUNK)}`,
      );
    }
    return all('diagnosticDone', { count });
  });

  // --- Devices -----------------------------------------------------------------------
  gladys.onScanRequest(async () => {
    await resolveConfig();
    const count = await publishDiscoveredDevices(true);
    logger.info(`Scan: ${count} device(s) offered`);
  });

  gladys.onDeviceCreated(async () => {
    await refreshCreatedDevices();
    // States sent before the device existed were dropped by Gladys, and the SDK
    // forgot what it sent for this device: send everything known again.
    for (const followed of stations) {
      await publishStationStates(followed);
    }
    if (traffic.data) {
      await digestTraffic();
    }
    refreshWidgets(Object.values(WIDGETS));
  });

  gladys.onDeviceDeleted(refreshCreatedDevices);

  // --- Configuration -----------------------------------------------------------------

  /**
   * @description Reload the whole config (internal keys included).
   * @param {object} [fallback] - Raw values to use when the read fails.
   * @returns {Promise<void>}
   */
  async function loadConfig(fallback) {
    try {
      const raw = await gladys.getConfig();
      rawConfig = raw ?? {};
      config = normalizeConfig(raw);
      language = readLanguage(raw, language);
    } catch (err) {
      if (fallback) {
        // The form values may lack the internal keys: never forget the added
        // stations, the next button would save the list without them.
        rawConfig = {
          [INTERNAL_KEYS.addedStations]: rawConfig[INTERNAL_KEYS.addedStations],
          ...fallback,
        };
        config = normalizeConfig(rawConfig);
      }
      logger.error('Unable to read the configuration', err);
    }
  }

  gladys.onConfigUpdated(async (raw) => {
    await loadConfig(raw);
    lastDiscovery = null;
    boards.clear();
    snapshots.clear();
    stationsError = null;
    logger.info('Configuration updated');
    await applyConfig();
  });

  // --- Connection lifecycle ----------------------------------------------------------
  // Each (re)connection resynchronizes; the promise lets the tests wait for it.
  let startup = Promise.resolve();
  gladys.on('connected', () => {
    startup = (async () => {
      await loadConfig();
      await store.load();
      await refreshCreatedDevices();
      lastStatus = null;
      lastDiscovery = null;
      await applyConfig();
    })().catch((err) => logger.error('Startup', err));
  });

  // --- Graceful shutdown -------------------------------------------------------------
  gladys.handleShutdown(async (signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    stopped = true;
    clearInterval(stationTimer);
    clearInterval(trafficTimer);
    clearInterval(reminderTimer);
    clearTimeout(resolveTimer);
    await store.save();
  });

  return {
    store,
    api,
    readStations,
    trafficTick,
    checkReminders,
    applyConfig,
    getConfig: () => config,
    getStations: () => stations,
    getLines: () => lines,
    getSnapshot: (key) => snapshots.get(key),
    getTraffic: () => traffic,
    whenReady: () => startup,
  };
}

export {
  createApp,
  ACTIONS,
  SCENE_ACTIONS,
  IDLE_INTERVAL_MS,
  TRAFFIC_INTERVAL_MS,
  SNAPSHOT_MAX_AGE_MS,
};
