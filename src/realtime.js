// -----------------------------------------------------------------------------
// The real time of Renfe: the GTFS Realtime feeds of gtfsrt.renfe.com, read
// in their JSON form (the protobuf one says the same), written the way the
// rest of the integration reads them.
//
//   - trip updates: one feed for the Cercanías (`trip_updates.json`), one for
//     the long and medium distance (`trip_updates_LD.json`). Renfe sends, per
//     trip under way, ONE stop time update — the next station, its estimate
//     (`time`) and its delay — and the delay of the trip; a cancelled trip
//     (CANCELED) has none; a station not served is a SKIPPED one; a trip
//     added (ADDED, "SPECIAL_…") is not in the timetable and is left out.
//     Long distance trips are cancelled days ahead: the trip id holds the
//     date (`0043712026-11-17`);
//   - vehicle positions (Cercanías): the station a train is at or about to
//     reach, and its track in the label ("C4-23667-PLATF.(8)");
//   - service alerts (Cercanías only): Spanish texts, about lines (route ids,
//     one per direction) or stations (lifts out of order, closed stations),
//     a start and seldom an end.
// Numbers come as strings ("1794951420"): read with Number().
// -----------------------------------------------------------------------------

const asNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const asString = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * @description The entities of a feed.
 * @param {unknown} json - The parsed feed.
 * @returns {{ timestamp: number|null, entities: object[] }} Its header time
 * (Unix seconds) and entities.
 */
function entitiesOf(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.entity)) {
    throw new Error('not a GTFS-RT feed');
  }
  return {
    timestamp: asNumber(json.header?.timestamp),
    entities: json.entity.filter((entity) => entity && typeof entity === 'object'),
  };
}

/**
 * @description An arrival or departure event.
 * @param {unknown} event - `{ time, delay }`.
 * @returns {{ time: number|null, delay: number|null }|null} The event.
 */
function eventOf(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const time = asNumber(event.time);
  const delay = asNumber(event.delay);
  return time === null && delay === null ? null : { time, delay };
}

/**
 * @description Read a feed of trip updates.
 * @param {unknown} json - The parsed `trip_updates*.json`.
 * @returns {{ timestamp: number|null, tripUpdates: object[] }} The updates:
 * `{ tripId, cancelled, delay, stops: [{ stopId, arrival, departure,
 * skipped }] }`, `delay` in seconds (null when not sent).
 */
function readTripUpdates(json) {
  const { timestamp, entities } = entitiesOf(json);
  const tripUpdates = [];
  for (const entity of entities) {
    const update = entity.tripUpdate;
    const tripId = asString(update?.trip?.tripId);
    const relationship = asString(update?.trip?.scheduleRelationship) || 'SCHEDULED';
    // An added train has no timetable to correct.
    if (!tripId || relationship === 'ADDED') {
      continue;
    }
    tripUpdates.push({
      tripId,
      cancelled: relationship === 'CANCELED' || relationship === 'CANCELLED',
      delay: asNumber(update.delay),
      stops: asArray(update.stopTimeUpdate)
        .filter((stop) => stop && typeof stop === 'object' && asString(stop.stopId))
        .map((stop) => ({
          stopId: asString(stop.stopId),
          arrival: eventOf(stop.arrival),
          departure: eventOf(stop.departure),
          skipped: asString(stop.scheduleRelationship) === 'SKIPPED',
          noData: asString(stop.scheduleRelationship) === 'NO_DATA',
        })),
    });
  }
  return { timestamp, tripUpdates };
}

/**
 * @description The track of a vehicle label: "C4-23667-PLATF.(8)" -> "8".
 * @param {string} label - The label.
 * @returns {string} The track, '' when none.
 */
function trackOf(label) {
  return /PLATF\.?\s*\(\s*([0-9A-Za-z]{1,4})\s*\)/i.exec(label)?.[1] ?? '';
}

/**
 * @description Read a feed of vehicle positions.
 * @param {unknown} json - The parsed `vehicle_positions.json`.
 * @returns {Map<string, { stopId: string, status: string, track: string }>}
 * Trip id -> the station the train is at or heading to, and its track there.
 */
function readVehicles(json) {
  const { entities } = entitiesOf(json);
  const vehicles = new Map();
  for (const entity of entities) {
    const vehicle = entity.vehicle;
    const tripId = asString(vehicle?.trip?.tripId);
    if (!tripId) {
      continue;
    }
    vehicles.set(tripId, {
      stopId: asString(vehicle.stopId),
      status: asString(vehicle.currentStatus),
      track: trackOf(asString(vehicle.vehicle?.label)),
    });
  }
  return vehicles;
}

/**
 * @description The text of a translated string, Spanish first.
 * @param {unknown} value - `{ translation: [{ text, language }] }`.
 * @returns {string} The text, '' when none.
 */
function translatedText(value) {
  const translations = asArray(value?.translation).filter(
    (item) => item && typeof item.text === 'string' && item.text.trim(),
  );
  const chosen =
    translations.find((item) => /^es/i.test(item.language ?? '')) ?? translations[0] ?? null;
  return chosen ? chosen.text.trim() : '';
}

/**
 * @description Read a feed of service alerts.
 * @param {unknown} json - The parsed `alerts.json`.
 * @returns {{ timestamp: number|null, alerts: object[] }} The alerts: `{ id,
 * routeIds, stopIds, periods: [{ start, end }] (Unix seconds, null when
 * open), effect, severity, header, description, url }`.
 */
function readAlerts(json) {
  const { timestamp, entities } = entitiesOf(json);
  const alerts = [];
  for (const entity of entities) {
    const alert = entity.alert;
    if (!alert || typeof alert !== 'object') {
      continue;
    }
    const informed = asArray(alert.informedEntity).filter(
      (item) => item && typeof item === 'object',
    );
    alerts.push({
      id: asString(entity.id),
      routeIds: [...new Set(informed.map((item) => asString(item.routeId)).filter(Boolean))],
      stopIds: [...new Set(informed.map((item) => asString(item.stopId)).filter(Boolean))],
      periods: asArray(alert.activePeriod)
        .filter((period) => period && typeof period === 'object')
        .map((period) => ({ start: asNumber(period.start), end: asNumber(period.end) })),
      effect: asString(alert.effect) || null,
      severity: asString(alert.severityLevel) || null,
      header: translatedText(alert.headerText),
      description: translatedText(alert.descriptionText),
      url: translatedText(alert.url),
    });
  }
  return { timestamp, alerts };
}

export { entitiesOf, readTripUpdates, trackOf, readVehicles, translatedText, readAlerts };
