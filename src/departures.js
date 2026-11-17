// -----------------------------------------------------------------------------
// The trains of a followed station: the timetable of the GTFS (network.js),
// corrected by the real time of the GTFS-RT trip updates.
//
//   - the timetable gives each call at the station: its trip (line, train
//     number, destination), its service (the dates it runs) and its times, in
//     seconds from the noon of the service day minus 12 hours (beyond 24:00
//     after midnight: GTFS times, never wall-clock times). With a destination
//     station, only the trains calling there AFTER the station are kept, with
//     their arrival there; without one, every train leaving the station (not
//     the ones ending there);
//   - the trip update of the same trip id: Renfe sends, per train under way,
//     the estimate and the delay at its NEXT station only, and the delay of
//     the train. A station without its own estimate takes the delay of the
//     announced station before it (GTFS-RT propagation): the delay of a train
//     still coming is known, the one of a train gone too. A cancelled train
//     or a skipped station makes a cancelled passage: Renfe names the trip
//     without its date, so for the runs of the next six hours only. A train never leaves
//     before its time: an early estimate (Renfe sends some, -4 min) counts on
//     time;
//   - the vehicle positions give the track of a Cercanías train at the
//     station it is at or about to reach ("vía 8");
//   - a train without a trip update is the timetable only ("(teórico)"):
//     Renfe follows a train once it left its first station.
// -----------------------------------------------------------------------------

import { fold } from './network.js';
import { wallToInstant } from './time.js';

const HOUR_MS = 3600 * 1000;
// The trains listed: the next four hours; a line silent that long shows its
// first train of the next 24 hours.
const HORIZON_MS = 4 * HOUR_MS;
const LOOKAHEAD_MS = 24 * HOUR_MS;
// A train gone this long is dropped (a late one may still come).
const BEHIND_MS = 3 * HOUR_MS;
const MAX_PER_ROUTE = 8;
// An estimate further than this from the timetable belongs to another day.
const MATCH_MS = 4 * HOUR_MS;
// A cancellation (or a skipped station) counts for the runs this close.
const CANCEL_BEHIND_MS = 12 * HOUR_MS;
const CANCEL_AHEAD_MS = 6 * HOUR_MS;

/**
 * @description The instant GTFS times of a service day count from: noon of
 * that day in Madrid minus 12 hours (midnight, except on the days the clocks
 * change).
 * @param {string} date - "20261117".
 * @returns {number} The instant (ms).
 */
function serviceStart(date) {
  const wall = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6)),
    12,
  );
  return wallToInstant(wall) - 12 * HOUR_MS;
}

/**
 * @description Index the trip updates by trip id.
 * @param {...object|null} feeds - readTripUpdates() of the feeds.
 * @returns {Map<string, object>} Trip id -> `{ cancelled, delay, stops:
 * [{ stopId, at, delay, skipped }] }`, `at` in ms, delays in seconds (null
 * when not sent).
 */
function indexTripUpdates(...feeds) {
  const index = new Map();
  for (const feed of feeds) {
    for (const update of feed?.tripUpdates ?? []) {
      if (!update.tripId) {
        continue;
      }
      index.set(update.tripId, {
        cancelled: update.cancelled,
        delay: update.delay ?? null,
        stops: update.stops
          .filter((stop) => !stop.noData)
          .map((stop) => {
            const event = stop.departure?.time ? stop.departure : stop.arrival;
            return {
              stopId: stop.stopId,
              at: Number.isFinite(event?.time) ? event.time * 1000 : null,
              delay: stop.departure?.delay ?? stop.arrival?.delay ?? update.delay ?? null,
              skipped: stop.skipped,
            };
          }),
      });
    }
  }
  return index;
}

/**
 * @description What the real time says of one call.
 * @param {object|undefined} update - The indexed trip update.
 * @param {string} stopId - The station.
 * @param {number} scheduled - The timetable (ms).
 * @param {number} now - Now (ms).
 * @returns {{ at: number, delay: number, realtime: boolean, cancelled: boolean }}
 * The estimate (the timetable when none), its delay in ms.
 */
function applyRealtime(update, stopId, scheduled, now) {
  const plain = { at: scheduled, delay: 0, realtime: false, cancelled: false };
  if (!update) {
    return plain;
  }
  // Renfe names a trip without its date, and a trip id of the long distance
  // runs for weeks: a cancellation speaks of the run of the coming hours, not
  // of the one of tomorrow morning.
  const near = scheduled >= now - CANCEL_BEHIND_MS && scheduled <= now + CANCEL_AHEAD_MS;
  if (update.cancelled) {
    return near ? { ...plain, cancelled: true } : plain;
  }
  const own = update.stops.filter((stop) => stop.stopId === stopId);
  // A skipped station carries no time: the train of today does not stop there.
  if (
    own.some((stop) => stop.skipped) &&
    !own.some((stop) => !stop.skipped && stop.at !== null) &&
    near
  ) {
    return { ...plain, cancelled: true };
  }
  const late = (delay) => Math.max(0, delay);
  const estimate = own
    .filter((stop) => !stop.skipped)
    .map((stop) => {
      if (stop.delay !== null) {
        return late(stop.delay * 1000);
      }
      return stop.at !== null ? late(stop.at - scheduled) : null;
    })
    .find((delay) => delay !== null && delay <= MATCH_MS);
  if (estimate !== undefined) {
    return { at: scheduled + estimate, delay: estimate, realtime: true, cancelled: false };
  }
  // No estimate for this station: the delay of the announced one before it.
  const before = update.stops
    .filter((stop) => stop.at !== null && stop.delay !== null && !stop.skipped)
    .map((stop) => ({ ...stop, scheduled: stop.at - stop.delay * 1000 }))
    .filter((stop) => stop.scheduled <= scheduled && scheduled - stop.scheduled <= MATCH_MS)
    .sort((a, b) => b.scheduled - a.scheduled);
  if (before.length > 0) {
    const delay = late(before[0].delay * 1000);
    return { at: scheduled + delay, delay, realtime: true, cancelled: false };
  }
  return plain;
}

/**
 * @description The calls of a timetable, by trip, at some stations.
 * @param {object[]} rows - The rows of the timetable.
 * @param {Set<string>} stations - The station codes.
 * @returns {Map<string, object[]>} Trip id -> its rows there.
 */
function callsByTrip(rows, stations) {
  const calls = new Map();
  for (const row of rows) {
    if (stations.has(row[1])) {
      calls.set(row[0], [...(calls.get(row[0]) ?? []), row]);
    }
  }
  return calls;
}

/**
 * @description The trains of a station, soonest first.
 * @param {object} options - Options.
 * @param {object|null} options.timetable - network.timetable().
 * @param {object} options.station - The station (`ids`).
 * @param {object|null} [options.destination] - Only the trains calling at
 * this station after it.
 * @param {object|null} [options.line] - Only this line (`routeIds`).
 * @param {Map|null} [options.realtime] - indexTripUpdates().
 * @param {Map|null} [options.vehicles] - readVehicles().
 * @param {number} options.now - Now (ms).
 * @param {Function} [options.lineOfRoute] - `(route id) => line`.
 * @returns {object[]} The passages, cancelled ones included: `{ lineId, line,
 * network, number, destination, at, scheduled, arrival, scheduledArrival,
 * realtime, delay, cancelled, track, trip, platform }`, `trip` the trip id
 * and its service date, `arrival` at the destination station (null without
 * one), `delay` in minutes.
 */
function buildPassages({
  timetable,
  station,
  destination = null,
  line = null,
  realtime = null,
  vehicles = null,
  now,
  lineOfRoute = () => null,
}) {
  if (!timetable) {
    return [];
  }
  const routes = line ? new Set(line.routeIds) : null;
  const arrivals = destination ? callsByTrip(timetable.rows, new Set(destination.ids)) : new Map();
  const starts = new Map();
  const startOf = (date) => {
    if (!starts.has(date)) {
      starts.set(date, serviceStart(date));
    }
    return starts.get(date);
  };
  const ids = new Set(station.ids);
  const passages = [];
  for (const [tripId, stopId, departure, , sequence, boarding] of timetable.rows) {
    if (!ids.has(stopId) || !boarding) {
      continue;
    }
    const trip = timetable.trips[tripId];
    if (!trip || (routes && !routes.has(trip[0]))) {
      continue;
    }
    const [routeId, serviceId, headsign, number, lastSequence] = trip;
    let arrivalRow = null;
    if (destination) {
      arrivalRow = (arrivals.get(tripId) ?? []).find((row) => row[4] > sequence && row[6]);
      if (!arrivalRow) {
        continue;
      }
    } else if (sequence >= lastSequence) {
      // The train ends here.
      continue;
    }
    const known = lineOfRoute(routeId);
    for (const date of timetable.services[serviceId] ?? []) {
      const start = startOf(date);
      const scheduled = start + departure * 1000;
      if (scheduled < now - BEHIND_MS || scheduled > now + LOOKAHEAD_MS + MATCH_MS) {
        continue;
      }
      const update = realtime?.get(tripId);
      const estimate = applyRealtime(update, stopId, scheduled, now);
      const scheduledArrival = arrivalRow ? start + arrivalRow[3] * 1000 : null;
      let arrival = scheduledArrival;
      if (arrivalRow && estimate.realtime) {
        // Not the delay of the departure: the one Renfe announces for the
        // destination when the train is past the station.
        const there = applyRealtime(update, arrivalRow[1], scheduledArrival, now);
        arrival = there.realtime ? there.at : scheduledArrival + estimate.delay;
      }
      const vehicle = vehicles?.get(tripId);
      passages.push({
        lineId: known?.id ?? routeId,
        line: known?.name ?? routeId,
        network: known?.network ?? '',
        number,
        destination: String(headsign ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
        at: estimate.at,
        scheduled,
        arrival,
        scheduledArrival,
        realtime: estimate.realtime,
        // `|| 0`: never a -0 minute.
        delay: estimate.realtime ? Math.round(estimate.delay / 60000) || 0 : 0,
        cancelled: estimate.cancelled,
        track: vehicle && vehicle.stopId === stopId ? vehicle.track : '',
        trip: `${tripId}@${date}`,
        platform: stopId,
      });
    }
  }
  passages.sort((a, b) => a.at - b.at);
  // The next hours, a few per route; the first train of a silent route.
  const kept = [];
  const counts = new Map();
  for (const passage of passages) {
    const gone = passage.cancelled ? passage.scheduled < now - 30000 : passage.at < now - 30000;
    if (gone || passage.at > now + LOOKAHEAD_MS) {
      continue;
    }
    const route = routeOf(passage);
    const count = counts.get(route) ?? 0;
    if (count >= MAX_PER_ROUTE || (passage.at > now + HORIZON_MS && count > 0)) {
      continue;
    }
    counts.set(route, count + 1);
    kept.push(passage);
  }
  return kept;
}

/**
 * @description The minutes left before a passage.
 * @param {object} passage - The passage.
 * @param {number} now - Now (ms).
 * @returns {number} Whole minutes (rounded down, like the screens).
 */
function minutesLeft(passage, now) {
  return Math.max(0, Math.floor((passage.at - now) / 60000));
}

/**
 * @description The passages not gone yet, cancelled ones left out.
 * @param {object[]} passages - The passages.
 * @param {number} now - Now (ms).
 * @returns {object[]} The passages to come.
 */
const upcomingPassages = (passages, now) =>
  passages.filter((passage) => !passage.cancelled && passage.at > now - 30000);

/**
 * @description The cancelled passages not gone yet.
 * @param {object[]} passages - The passages.
 * @param {number} now - Now (ms).
 * @returns {object[]} The cancelled passages to come.
 */
const cancelledPassages = (passages, now) =>
  passages.filter((passage) => passage.cancelled && passage.scheduled > now - 30000);

/**
 * @description Who a passage is, across readings: line and destination.
 * @param {object} passage - The passage.
 * @returns {string} "10-c3|aranjuez".
 */
const routeOf = (passage) => `${passage.lineId}|${fold(passage.destination)}`;

/**
 * @description How a train is named: "AVE 3063" for the long distance (the
 * number on the ticket), "C3" for the Cercanías.
 * @param {object} passage - The passage.
 * @returns {string} The name.
 */
const trainLabel = (passage) =>
  passage.network === 'ld' && passage.number ? `${passage.line} ${passage.number}` : passage.line;

export {
  HORIZON_MS,
  LOOKAHEAD_MS,
  serviceStart,
  indexTripUpdates,
  applyRealtime,
  callsByTrip,
  buildPassages,
  minutesLeft,
  upcomingPassages,
  cancelledPassages,
  routeOf,
  trainLabel,
};
