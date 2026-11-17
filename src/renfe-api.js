// -----------------------------------------------------------------------------
// HTTP client of the open data of Renfe (data.renfe.com). No key, no
// account; licence of the open data of Renfe (reuse allowed, source cited).
//   - the timetables: two GTFS zips on ssl.renfe.com, one for the long and
//     medium distance (0.7 MB), one for the Cercanías and Rodalies (15 MB),
//     both published each night. The server answers no conditional request
//     (always 200), and its servers disagree on the dates of one file by a
//     few seconds (so do their ETags): a HEAD gives the size and the date of
//     the zip, and it is downloaded only when its size changed or its date
//     moved by more than 30 minutes;
//   - the real time on gtfsrt.renfe.com, in JSON: the trip updates of the
//     Cercanías (about 70 KB) and of the long distance (about 150 KB), the
//     vehicle positions of the Cercanías (60 KB, their tracks), the alerts of
//     the Cercanías (80 KB). Refreshed every 30 seconds (Cache-Control).
// Datasets: https://data.renfe.com/
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { readTripUpdates, readVehicles, readAlerts } from './realtime.js';

const NETWORKS = { LD: 'ld', CER: 'cer' };
const GTFS_URLS = {
  [NETWORKS.LD]:
    process.env.RENFE_GTFS_LD_URL ||
    'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
  [NETWORKS.CER]:
    process.env.RENFE_GTFS_CER_URL ||
    'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
};
const FEEDS_URL = process.env.RENFE_API_URL || 'https://gtfsrt.renfe.com';
const TIMEOUT_MS = 20000;
const GTFS_TIMEOUT_MS = 180000;
// The Cercanías zip is about 15 MB: anything far bigger is not the timetable.
const GTFS_MAX_BYTES = 96 * 1024 * 1024;
const FEED_MAX_BYTES = 8 * 1024 * 1024;
// Two dates of one zip given by two servers of Renfe differ by seconds; a new
// zip is published a day later.
const SAME_FILE_MS = 30 * 60 * 1000;
// A feed refused with 429 or 503 is asked again once, a few seconds later.
const BUSY_RETRIES = 1;
const BUSY_PAUSE_MS = 5000;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const USER_AGENT = `gladys-renfe/${version} (+https://github.com/William-De71/gladys-renfe)`;

const ENDPOINTS = {
  GTFS_LD: 'gtfs_ld',
  GTFS_CER: 'gtfs_cer',
  TRIP_UPDATES_LD: 'trip_updates_ld',
  TRIP_UPDATES_CER: 'trip_updates_cer',
  VEHICLES: 'vehicles',
  ALERTS: 'alerts',
};

const FEED_PATHS = {
  [ENDPOINTS.TRIP_UPDATES_LD]: '/trip_updates_LD.json',
  [ENDPOINTS.TRIP_UPDATES_CER]: '/trip_updates.json',
  [ENDPOINTS.VEHICLES]: '/vehicle_positions.json',
  [ENDPOINTS.ALERTS]: '/alerts.json',
};

class RenfeError extends Error {
  /**
   * @param {string} kind - `busy`, `unreachable` or `invalid`.
   * @param {string} message - The detail.
   * @param {object} [extra] - `{ status }`.
   */
  constructor(kind, message, { status = null } = {}) {
    super(message);
    this.name = 'RenfeError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * @description Whether two versions of a zip name the same file: the same
 * size, dates within SAME_FILE_MS (the servers of Renfe disagree by seconds).
 * @param {string} current - versionOf() of the server.
 * @param {string} known - The version kept.
 * @returns {boolean} True when the zip kept is the current one.
 * @example
 * sameVersion('689886@1794873941000', '689886@1794873939000'); // -> true
 */
function sameVersion(current, known) {
  if (!current || !known) {
    return false;
  }
  const parse = (version) => /^(\d+)@(\d+)$/.exec(version);
  const [a, b] = [parse(current), parse(known)];
  if (!a || !b) {
    return current === known;
  }
  return a[1] === b[1] && Math.abs(Number(a[2]) - Number(b[2])) <= SAME_FILE_MS;
}

/**
 * @description A client of the open data of Renfe.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetch] - The fetch function (tests).
 * @param {Function} [options.now] - `() => number` in ms.
 * @param {Function} [options.sleep] - `(ms) => Promise` (tests).
 * @param {string} [options.feedsUrl] - The root of the feeds (tests, end-to-end runs).
 * @param {object} [options.gtfsUrls] - `{ ld, cer }`: the zips.
 * @returns {object} The methods, and `requests` for the diagnostic.
 */
function createRenfeClient({
  fetch: fetchFn = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  feedsUrl = FEEDS_URL,
  gtfsUrls = GTFS_URLS,
} = {}) {
  // Requests made, per endpoint, for the diagnostic.
  const requests = { total: 0, byEndpoint: {}, failed: 0, busy: 0, notModified: 0, last: null };

  /**
   * @description Ask a URL.
   * @param {string} endpoint - ENDPOINTS, for the counters.
   * @param {string} url - The URL.
   * @param {object} [options] - `{ timeout, method }`.
   * @returns {Promise<Response>} The answer (2xx).
   */
  async function call(endpoint, url, { timeout = TIMEOUT_MS, method = 'GET' } = {}) {
    requests.total += 1;
    requests.byEndpoint[endpoint] = (requests.byEndpoint[endpoint] ?? 0) + 1;
    requests.last = now();
    let response;
    try {
      response = await fetchFn(url, {
        method,
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      requests.failed += 1;
      throw new RenfeError('unreachable', err.cause?.code ?? err.message);
    }
    if (!response.ok) {
      let kind = 'unreachable';
      if (response.status === 429 || response.status === 503) {
        kind = 'busy';
        requests.busy += 1;
      } else {
        requests.failed += 1;
        if (response.status >= 400 && response.status < 500) {
          kind = 'invalid';
        }
      }
      throw new RenfeError(kind, `${endpoint}: HTTP ${response.status}`, {
        status: response.status,
      });
    }
    return response;
  }

  /**
   * @description The bytes of an answer.
   * @param {string} endpoint - ENDPOINTS.
   * @param {Response} response - The answer.
   * @param {number} max - The largest accepted size.
   * @returns {Promise<Buffer>} The bytes.
   */
  async function bytesOf(endpoint, response, max) {
    let body;
    try {
      body = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      requests.failed += 1;
      throw new RenfeError('unreachable', `${endpoint}: ${err.message}`);
    }
    if (body.length > max) {
      requests.failed += 1;
      throw new RenfeError('invalid', `${endpoint}: ${body.length} bytes`);
    }
    return body;
  }

  /**
   * @description A feed, asked again once while the server is busy, read by
   * `reader`.
   * @param {string} endpoint - ENDPOINTS.
   * @param {Function} reader - realtime.js reader.
   * @returns {Promise<object>} What the reader gives.
   */
  async function feed(endpoint, reader) {
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await call(endpoint, `${feedsUrl}${FEED_PATHS[endpoint]}`);
        break;
      } catch (err) {
        if (err.kind !== 'busy' || attempt >= BUSY_RETRIES) {
          throw err;
        }
        await sleep(BUSY_PAUSE_MS);
      }
    }
    const body = await bytesOf(endpoint, response, FEED_MAX_BYTES);
    try {
      return reader(JSON.parse(body.toString('utf8')));
    } catch (err) {
      requests.failed += 1;
      throw new RenfeError('invalid', `${endpoint}: ${err.message}`);
    }
  }

  /**
   * @description The version of a zip on the server: its size and its date.
   * @param {Response} response - An answer (HEAD or GET).
   * @param {number} [size] - The size of the body read, when known.
   * @returns {string} "15621401@1794885312000", '' when the server sends neither.
   */
  const versionOf = (response, size) => {
    const length = Number(response.headers.get('content-length') ?? size ?? NaN);
    const date = Date.parse(response.headers.get('last-modified') ?? '');
    if (!Number.isFinite(length) || !Number.isFinite(date)) {
      return response.headers.get('etag') ?? '';
    }
    return `${length}@${date}`;
  };

  return {
    requests,
    /**
     * @description A timetable, when a new file was published.
     * @param {string} network - NETWORKS.
     * @param {string} [known] - The version of the zip kept.
     * @returns {Promise<{ zip: Buffer, lastModified: string }|null>} The
     * archive and its version, null when the zip kept is still the current one.
     */
    gtfs: async (network, known = '') => {
      const endpoint = network === NETWORKS.CER ? ENDPOINTS.GTFS_CER : ENDPOINTS.GTFS_LD;
      const url = gtfsUrls[network];
      if (known) {
        const head = await call(endpoint, url, { method: 'HEAD' });
        if (sameVersion(versionOf(head), known)) {
          requests.notModified += 1;
          return null;
        }
      }
      const response = await call(endpoint, url, { timeout: GTFS_TIMEOUT_MS });
      const zip = await bytesOf(endpoint, response, GTFS_MAX_BYTES);
      return { zip, lastModified: versionOf(response, zip.length) || `${zip.length}@0` };
    },
    /**
     * @description The trip updates of a network.
     * @param {string} network - NETWORKS.
     * @returns {Promise<object>} `{ timestamp, tripUpdates }`.
     */
    tripUpdates: (network) =>
      feed(
        network === NETWORKS.CER ? ENDPOINTS.TRIP_UPDATES_CER : ENDPOINTS.TRIP_UPDATES_LD,
        readTripUpdates,
      ),
    /**
     * @description The positions of the Cercanías trains.
     * @returns {Promise<Map>} readVehicles().
     */
    vehicles: () => feed(ENDPOINTS.VEHICLES, readVehicles),
    /**
     * @description The service alerts of the Cercanías.
     * @returns {Promise<object>} `{ timestamp, alerts }`.
     */
    alerts: () => feed(ENDPOINTS.ALERTS, readAlerts),
  };
}

export {
  NETWORKS,
  GTFS_URLS,
  FEEDS_URL,
  USER_AGENT,
  ENDPOINTS,
  FEED_PATHS,
  BUSY_RETRIES,
  BUSY_PAUSE_MS,
  RenfeError,
  sameVersion,
  createRenfeClient,
};
