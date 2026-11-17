// -----------------------------------------------------------------------------
// The GTFS of Renfe (the timetables, zips of CSV files), read without
// dependency: the zip through its central directory and zlib, the CSV by
// hand. Renfe publishes two of them, read the same way:
//   - the long and medium distance trains (AVE, Avlo, Alvia, Intercity,
//     Regional, Avant…: 0.7 MB, stop_times.txt 18 MB once inflated);
//   - the Cercanías and Rodalies of every núcleo (15 MB, stop_times.txt
//     272 MB once inflated).
// Renfe pads some files with spaces after each cell (and after each line):
// every cell is trimmed. Files used:
//   routes.txt          the routes: a product of long distance ("AVE"), or a
//                       Cercanías line in one direction ("C1", route ids
//                       "10T0001C1" whose two first digits are the núcleo);
//   stops.txt           the stations (one stop per station, no platform: the
//                       station codes of Adif, shared by the two files);
//   trips.txt           route, service, headsign and train number of each
//                       trip (streamed; only the trips of the services running
//                       in the window are kept);
//   calendar.txt        the weekly pattern of each service;
//   calendar_dates.txt  its exceptions (long distance only);
//   stop_times.txt      inflated as a stream and scanned line by line, never
//                       held whole; only the rows of the wanted stations are
//                       kept, and the lines calling at each station.
// -----------------------------------------------------------------------------

import { inflateRaw, createInflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(inflateRaw);
// The chunks of a streamed entry.
const STREAM_CHUNK = 256 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

class GtfsError extends Error {
  /**
   * @param {string} message - The detail.
   */
  constructor(message) {
    super(message);
    this.name = 'GtfsError';
    this.kind = 'invalid';
  }
}

/**
 * @description The entries of a zip archive.
 * @param {Buffer} zip - The archive.
 * @returns {Map<string, { method: number, offset: number, size: number }>}
 * Name -> compression method, offset of the local header, compressed size.
 */
function zipEntries(zip) {
  // The end of central directory record sits in the last 64 KB.
  let eocd = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 65557); index -= 1) {
    if (zip.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) {
    throw new GtfsError('not a zip archive');
  }
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new GtfsError('broken zip directory');
    }
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name.split('/').pop(), { method, offset: local, size });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * @description The text of a file of the archive.
 * @param {Buffer} zip - The archive.
 * @param {Map} entries - zipEntries().
 * @param {string} name - "stops.txt".
 * @returns {Promise<Buffer|null>} Its bytes (UTF-8), null when absent.
 */
async function readEntry(zip, entries, name) {
  const entry = entries.get(name);
  if (!entry) {
    return null;
  }
  const data = entryData(zip, entry, name);
  return entry.method === 0 ? data : inflate(data);
}

/**
 * @description The stored bytes of an entry.
 * @param {Buffer} zip - The archive.
 * @param {object} entry - Its entry of zipEntries().
 * @param {string} name - Its name, for the errors.
 * @returns {Buffer} The compressed (or stored) bytes.
 */
function entryData(zip, entry, name) {
  const { offset } = entry;
  if (zip.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new GtfsError(`broken entry ${name}`);
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new GtfsError(`${name}: compression ${entry.method}`);
  }
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
  return zip.subarray(start, start + entry.size);
}

/**
 * @description Go through the rows of a big file of the archive, inflated as
 * a stream: its text is never whole in memory (stop_times.txt is 272 MB).
 * @param {Buffer} zip - The archive.
 * @param {Map} entries - zipEntries().
 * @param {string} name - "stop_times.txt".
 * @param {Function} visit - `(row: string[], column: (name) => index)`.
 * @returns {Promise<void>}
 */
async function eachEntryRow(zip, entries, name, visit) {
  const entry = entries.get(name);
  if (!entry) {
    return;
  }
  const data = entryData(zip, entry, name);
  const rows = createRowReader(visit);
  if (entry.method === 0) {
    rows.push(data);
    rows.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createInflateRaw({ chunkSize: STREAM_CHUNK });
    stream.on('data', (chunk) => {
      try {
        rows.push(chunk);
      } catch (err) {
        stream.destroy(err);
      }
    });
    stream.on('error', (err) => reject(new GtfsError(`${name}: ${err.message}`)));
    stream.on('end', () => {
      try {
        rows.end();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    stream.end(data);
  });
}

/**
 * @description Split one CSV line (RFC 4180 quotes).
 * @param {string} line - The line, without its line break.
 * @returns {string[]} The cells.
 * @example
 * splitCsvLine('a,"b, c",d'); // -> ['a', 'b, c', 'd']
 */
function splitCsvLine(line) {
  if (!line.includes('"')) {
    return line.split(',');
  }
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * @description A reader of CSV rows fed by chunks of bytes: the lines cut
 * between two chunks are joined, the rest is read in place.
 * @param {Function} visit - `(row: string[], column: (name) => index)`.
 * @returns {{ push: (chunk: Buffer) => void, end: () => void }} The reader.
 */
function createRowReader(visit) {
  let header = null;
  let rest = null;
  const column = (name) => header.indexOf(name);
  const line = (bytes, start, end) => {
    const stop = end > start && bytes[end - 1] === 0x0d ? end - 1 : end;
    const text = bytes.toString('utf8', start, stop);
    if (!text) {
      return;
    }
    if (!header) {
      header = splitCsvLine(text.replace(/^\uFEFF/, '')).map((name) => name.trim());
      return;
    }
    // Renfe pads its cells with spaces.
    visit(
      splitCsvLine(text).map((cell) => cell.trim()),
      column,
    );
  };
  return {
    push(chunk) {
      const bytes = rest ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
        line(bytes, start, end);
        start = end + 1;
      }
      // Copied: a slice would keep the whole chunk alive.
      rest = start < bytes.length ? Buffer.from(bytes.subarray(start)) : null;
    },
    end() {
      if (rest) {
        line(rest, 0, rest.length);
        rest = null;
      }
    },
  };
}

/**
 * @description Go through the rows of a CSV file, line by line from its bytes.
 * @param {Buffer|null} csv - The bytes (UTF-8).
 * @param {Function} visit - `(row: string[], column: (name) => index)`.
 */
function eachRow(csv, visit) {
  if (!csv) {
    return;
  }
  const rows = createRowReader(visit);
  rows.push(csv);
  rows.end();
}

/**
 * @description The seconds of a GTFS time, from the noon of the service day
 * minus 12 hours (beyond 24:00 for trips after midnight).
 * @param {string} value - "25:10:00".
 * @returns {number|null} Seconds, null when invalid.
 */
function gtfsSeconds(value) {
  const match = /^\s*(\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(value ?? '');
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

/**
 * @description The dates of each service, between two dates.
 * @param {Buffer|null} calendar - calendar.txt (optional).
 * @param {Buffer|null} calendarDates - calendar_dates.txt.
 * @param {string} from - First date, "20261027".
 * @param {string} to - Last date, "20261103".
 * @returns {Map<string, string[]>} Service id -> its dates, sorted.
 */
function serviceDates(calendar, calendarDates, from, to) {
  const dates = new Map();
  const add = (service, date) => {
    const set = dates.get(service) ?? new Set();
    set.add(date);
    dates.set(service, set);
  };
  const days = [];
  for (
    let day = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}T00:00:00Z`);
    day.toISOString().slice(0, 10).replace(/-/g, '') <= to;
    day = new Date(day.getTime() + 86400000)
  ) {
    days.push({ date: day.toISOString().slice(0, 10).replace(/-/g, ''), weekday: day.getUTCDay() });
  }
  eachRow(calendar, (row, column) => {
    const service = row[column('service_id')];
    const start = row[column('start_date')];
    const end = row[column('end_date')];
    for (const { date, weekday } of days) {
      if (date >= start && date <= end && row[column(WEEKDAYS[weekday])] === '1') {
        add(service, date);
      }
    }
  });
  eachRow(calendarDates, (row, column) => {
    const service = row[column('service_id')];
    const date = row[column('date')];
    if (date < from || date > to) {
      return;
    }
    if (row[column('exception_type')] === '2') {
      dates.get(service)?.delete(date);
    } else {
      add(service, date);
    }
  });
  return new Map(
    [...dates]
      .filter(([, set]) => set.size > 0)
      .map(([service, set]) => [service, [...set].sort()]),
  );
}

/**
 * @description The number of a train, from its trip.
 * @param {string} shortName - trip_short_name ("00190", long distance).
 * @param {string} tripId - The trip id ("1020M19799C1", Cercanías).
 * @param {string} serviceId - Its service ("1020M").
 * @returns {string} "190", "19799", '' when none.
 * @example
 * trainNumber('', '1020M19799C1', '1020M'); // -> '19799'
 */
function trainNumber(shortName, tripId, serviceId) {
  if (/^\d+$/.test(shortName)) {
    return String(Number(shortName));
  }
  // Cercanías: the service, the number, the line ("1020M" "19799" "C1").
  const rest = serviceId && tripId.startsWith(serviceId) ? tripId.slice(serviceId.length) : '';
  const digits = /^\d+/.exec(rest)?.[0];
  return digits ? String(Number(digits)) : '';
}

/**
 * @description Read the GTFS: the reference data, the lines of each
 * station, and the timetable of some stations between two dates.
 * @param {Buffer} zip - The GTFS archive.
 * @param {object} [options] - Options.
 * @param {Set<string>} [options.stopIds] - The stations whose timetable is
 * wanted (none: the reference data only).
 * @param {string} [options.from] - First service date, "20261117".
 * @param {string} [options.to] - Last service date.
 * @returns {Promise<object>} `{ routes, stops, linesByStop, timetable }`:
 * routes `[{ id, shortName, longName, type, color }]`, stops `[{ id, name,
 * lat, lon }]`, linesByStop `{ stopId: [routeId] }`, timetable `{ from, to,
 * services: { id: [dates] }, trips: { id: [routeId, serviceId, destination,
 * number, lastSequence] }, rows: [[tripId, stopId, departure, arrival,
 * sequence, boarding, alighting]] }`: the times in seconds from the noon of
 * the service day minus 12 hours, `boarding` false when nobody boards there
 * (pickup_type 1), `alighting` false when nobody leaves the train there.
 */
async function readGtfs(zip, { stopIds = new Set(), from = '', to = '' } = {}) {
  const entries = zipEntries(zip);
  for (const name of ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt']) {
    if (!entries.has(name)) {
      throw new GtfsError(`${name} missing`);
    }
  }
  const routes = [];
  eachRow(await readEntry(zip, entries, 'routes.txt'), (row, column) => {
    const cell = (name) => row[column(name)] ?? '';
    routes.push({
      id: cell('route_id'),
      shortName: cell('route_short_name'),
      // "Principe Pio      -Aeropuerto-T4": the padding of Renfe.
      longName: cell('route_long_name').replace(/\s+-/g, ' - ').replace(/\s+/g, ' '),
      type: Number(cell('route_type')),
      color: cell('route_color'),
    });
  });
  const stops = [];
  eachRow(await readEntry(zip, entries, 'stops.txt'), (row, column) => {
    const cell = (name) => row[column(name)] ?? '';
    // Entrances and the like (location_type 2 to 4) have no train.
    if (!['', '0', '1'].includes(cell('location_type'))) {
      return;
    }
    stops.push({
      id: cell('stop_id'),
      name: cell('stop_name'),
      lat: Number(cell('stop_lat')),
      lon: Number(cell('stop_lon')),
    });
  });
  // The services running in the window: the trips of the other days are
  // skipped (the Cercanías publish a month of trips, 130 000 of them).
  const windowed = Boolean(from && to);
  const wanted = stopIds.size > 0 && windowed;
  const services = windowed
    ? serviceDates(
        await readEntry(zip, entries, 'calendar.txt'),
        await readEntry(zip, entries, 'calendar_dates.txt'),
        from,
        to,
      )
    : new Map();
  // trip -> [route, service, headsign, number].
  const allTrips = new Map();
  await eachEntryRow(zip, entries, 'trips.txt', (row, column) => {
    const cell = (name) => row[column(name)] ?? '';
    if (windowed && !services.has(cell('service_id'))) {
      return;
    }
    const tripId = cell('trip_id');
    allTrips.set(tripId, [
      cell('route_id'),
      cell('service_id'),
      cell('trip_headsign'),
      trainNumber(cell('trip_short_name'), tripId, cell('service_id')),
    ]);
  });
  const lines = new Map();
  const rows = [];
  // The last station of each trip: its name is the destination.
  const last = new Map();
  let indexes = null;
  await eachEntryRow(zip, entries, 'stop_times.txt', (row, column) => {
    indexes ??= {
      trip: column('trip_id'),
      stop: column('stop_id'),
      departure: column('departure_time'),
      arrival: column('arrival_time'),
      sequence: column('stop_sequence'),
      pickup: column('pickup_type'),
      dropOff: column('drop_off_type'),
    };
    const tripId = row[indexes.trip];
    const stopId = row[indexes.stop];
    const trip = allTrips.get(tripId);
    if (!trip) {
      return;
    }
    const known = lines.get(stopId) ?? new Set();
    known.add(trip[0]);
    lines.set(stopId, known);
    if (!wanted) {
      return;
    }
    const sequence = Number(row[indexes.sequence]);
    const end = last.get(tripId);
    if (!end || sequence > end.sequence) {
      last.set(tripId, { sequence, stopId });
    }
    if (!stopIds.has(stopId)) {
      return;
    }
    const departure = gtfsSeconds(row[indexes.departure] || row[indexes.arrival]);
    const arrival = gtfsSeconds(row[indexes.arrival] || row[indexes.departure]);
    if (departure === null || arrival === null) {
      return;
    }
    rows.push([
      tripId,
      stopId,
      departure,
      arrival,
      sequence,
      (row[indexes.pickup] ?? '') !== '1',
      (row[indexes.dropOff] ?? '') !== '1',
    ]);
  });
  const names = new Map(stops.map((stop) => [stop.id, stop.name]));
  const trips = {};
  for (const [tripId] of rows) {
    if (trips[tripId]) {
      continue;
    }
    const [routeId, serviceId, headsign, number] = allTrips.get(tripId);
    const end = last.get(tripId);
    // The last station: the headsigns of the Cercanías say "CIVIS" (a
    // semi-fast service), not a place.
    trips[tripId] = [
      routeId,
      serviceId,
      names.get(end?.stopId) || headsign || '',
      number,
      end?.sequence ?? 0,
    ];
  }
  const usedServices = {};
  for (const trip of Object.values(trips)) {
    usedServices[trip[1]] ??= services.get(trip[1]);
  }
  return {
    routes: routes.filter((route) => route.id),
    stops: stops.filter((stop) => stop.id && stop.name),
    linesByStop: Object.fromEntries([...lines].map(([stopId, set]) => [stopId, [...set]])),
    timetable: wanted ? { from, to, services: usedServices, trips, rows } : null,
  };
}

export {
  GtfsError,
  zipEntries,
  readEntry,
  eachEntryRow,
  splitCsvLine,
  eachRow,
  gtfsSeconds,
  serviceDates,
  trainNumber,
  readGtfs,
};
