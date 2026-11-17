import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readTripUpdates,
  readVehicles,
  readAlerts,
  trackOf,
  translatedText,
} from '../src/realtime.js';
import { TRIP_UPDATES_CER, TRIP_UPDATES_LD, VEHICLES, ALERTS, NOW } from './helpers/fixtures.js';

test('trip updates: one station per train, the delay, cancellations, added trains left out', () => {
  const cer = readTripUpdates(TRIP_UPDATES_CER);
  assert.equal(cer.timestamp, NOW / 1000);
  const c8a = cer.tripUpdates.find((update) => update.tripId === '1020M21049C8a');
  assert.equal(c8a.cancelled, false);
  assert.equal(c8a.delay, 1260);
  assert.equal(c8a.stops.length, 1);
  assert.equal(c8a.stops[0].arrival.delay, 1260);
  assert.ok(Number.isFinite(c8a.stops[0].arrival.time));
  const ld = readTripUpdates(TRIP_UPDATES_LD);
  // The strike: most long distance trains of the day cancelled.
  assert.ok(ld.tripUpdates.filter((update) => update.cancelled).length > 200);
  assert.ok(!ld.tripUpdates.some((update) => update.tripId.startsWith('SPECIAL_')));
  const skipped = readTripUpdates({
    entity: [
      {
        id: 'TUUPDATE_0921512026-11-16',
        tripUpdate: {
          trip: { tripId: '0921512026-11-16', scheduleRelationship: 'SCHEDULED' },
          stopTimeUpdate: [
            { arrival: { delay: 300, time: '1794945600' }, stopId: '03410' },
            { stopId: '60911', scheduleRelationship: 'SKIPPED' },
          ],
          delay: 300,
        },
      },
    ],
  });
  assert.deepEqual(skipped.tripUpdates[0].stops, [
    {
      stopId: '03410',
      arrival: { time: 1794945600, delay: 300 },
      departure: null,
      skipped: false,
      noData: false,
    },
    { stopId: '60911', arrival: null, departure: null, skipped: true, noData: false },
  ]);
  assert.throws(() => readTripUpdates({ nothing: true }), /not a GTFS-RT feed/);
});

test('vehicle positions: the station and the track of the Cercanías trains', () => {
  const vehicles = readVehicles(VEHICLES);
  assert.deepEqual(vehicles.get('1020M21049C8a'), {
    stopId: '17000',
    status: vehicles.get('1020M21049C8a').status,
    track: '11',
  });
  assert.equal(trackOf('C4-23667-PLATF.(8)'), '8');
  assert.equal(trackOf('C4-23667'), '');
});

test('alerts: routes, stations, periods and the Spanish text', () => {
  const { alerts } = readAlerts(ALERTS);
  const c5 = alerts.find((alert) => alert.id === 'AVISO_525129');
  assert.deepEqual(c5.routeIds.slice(0, 2), ['10T0017C5', '10T0018C5']);
  assert.deepEqual(c5.periods, [{ start: 1794219780, end: null }]);
  assert.match(c5.description, /^#MadC5 Por obras de mejora/);
  const lift = alerts.find((alert) => alert.id === 'INFO_526407');
  assert.deepEqual(lift.routeIds, []);
  assert.deepEqual(lift.stopIds, ['18002']);
  // Two translations both said "es": the first one (Spanish before Valencian).
  assert.equal(
    translatedText({
      translation: [
        { text: 'Con motivo', language: 'es' },
        { text: 'Amb motiu', language: 'es' },
      ],
    }),
    'Con motivo',
  );
  assert.equal(translatedText({ translation: [{ text: 'Only', language: 'eu' }] }), 'Only');
  assert.equal(translatedText(null), '');
});
