import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serviceStart,
  indexTripUpdates,
  applyRealtime,
  buildPassages,
  minutesLeft,
  upcomingPassages,
  cancelledPassages,
  routeOf,
  trainLabel,
} from '../src/departures.js';
import { readTripUpdates } from '../src/realtime.js';
import { NOW, feedOf, tripUpdate, madrid, passage, fixturePassages } from './helpers/fixtures.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const index = (entities) => indexTripUpdates(readTripUpdates(feedOf(entities)));

test('GTFS times count from noon minus 12 hours, even when the clocks change', () => {
  assert.equal(serviceStart('20261117'), Date.parse('2026-11-16T23:00:00Z'));
  // 25 October 2026: back to winter time at 03:00. Noon minus 12 hours is
  // 01:00 summer time, not midnight.
  assert.equal(serviceStart('20261025'), Date.parse('2026-10-24T23:00:00Z'));
});

test('real time: the delay of the station, else of the announced one before it', () => {
  const scheduled = madrid('22:28');
  const at = (minutes) => (scheduled + minutes * MINUTE) / 1000;
  const updates = index([
    // Announced at the station: 3 minutes late.
    tripUpdate('A', { stopId: '18000', time: at(3), delay: 180 }),
    // Announced at Pinto, 15 min before: 6 minutes late.
    tripUpdate('B', { stopId: '35600', time: at(-15 + 6), delay: 360 }),
    // Four minutes early: on time, a train never leaves early.
    tripUpdate('C', { stopId: '18000', time: at(-4), delay: -240 }),
    tripUpdate('D', { cancelled: true }),
    tripUpdate('E', { stopId: '17000', time: at(-20), delay: 0, skipped: ['18000'] }),
  ]);
  assert.deepEqual(applyRealtime(updates.get('A'), '18000', scheduled, NOW), {
    at: scheduled + 3 * MINUTE,
    delay: 3 * MINUTE,
    realtime: true,
    cancelled: false,
  });
  assert.equal(applyRealtime(updates.get('B'), '18000', scheduled, NOW).at, scheduled + 6 * MINUTE);
  assert.deepEqual(applyRealtime(updates.get('C'), '18000', scheduled, NOW), {
    at: scheduled,
    delay: 0,
    realtime: true,
    cancelled: false,
  });
  assert.equal(applyRealtime(updates.get('D'), '18000', scheduled, NOW).cancelled, true);
  assert.equal(applyRealtime(updates.get('E'), '18000', scheduled, NOW).cancelled, true);
  // Renfe names the trip without its date: tomorrow morning is not cancelled.
  assert.equal(applyRealtime(updates.get('D'), '18000', NOW + 8 * HOUR, NOW).cancelled, false);
  assert.equal(applyRealtime(updates.get('D'), '18000', NOW + 5 * HOUR, NOW).cancelled, true);
  // A station of the trip before the announced one: nothing known.
  assert.equal(
    applyRealtime(updates.get('B'), '18000', scheduled - 30 * MINUTE, NOW).realtime,
    false,
  );
  assert.deepEqual(applyRealtime(undefined, '18000', scheduled, NOW), {
    at: scheduled,
    delay: 0,
    realtime: false,
    cancelled: false,
  });
});

test('the trains of a real station towards a destination: C3 and Regional to Aranjuez', async () => {
  const trains = await fixturePassages('18000', { destination: '60200' });
  assert.deepEqual(
    trains.map((p) => [trainLabel(p), p.destination, p.realtime, p.cancelled]),
    [
      ['C3', 'Aranjuez', true, false],
      ['C3', 'Aranjuez', false, false],
      ['C3', 'Aranjuez', false, false],
      ['Regional 17008', 'Alcázar de San Juan', false, false],
      ['Regional 18042', 'Albacete-Los Llanos', false, false],
      ['Regional 18036', 'Jaén', false, false],
    ],
  );
  const [first] = trains;
  assert.equal(first.number, '20108');
  assert.equal(first.network, 'cer');
  assert.equal(first.scheduled, madrid('22:28'));
  // Its arrival at Aranjuez: 23:13, on time.
  assert.equal(first.arrival, madrid('23:13'));
  assert.equal(minutesLeft(first, NOW), 22);
  // The long distance through the station keeps its number.
  assert.equal(trains[3].lineId, 'ld-regional');
  assert.equal(trains[3].network, 'ld');
});

test('every train leaving a station: delays, tracks, the line filter', async () => {
  const chamartin = await fixturePassages('17000');
  assert.ok(chamartin.every((p, i) => i === 0 || chamartin[i - 1].at <= p.at));
  const c8a = chamartin.find((p) => p.trip.startsWith('1020M21049C8a'));
  // Due at 21:47, 21 minutes late, at the station on track 11.
  assert.deepEqual([c8a.delay, c8a.at, c8a.track], [21, madrid('22:08'), '11']);
  // The ones ending there are left out.
  assert.ok(!chamartin.some((p) => p.destination === 'Madrid-Chamartín-Clara Campoamor'));
  assert.ok(chamartin.every((p) => p.at > NOW - 30000 && p.at <= NOW + 24 * HOUR));
  const routes = Map.groupBy(chamartin, routeOf);
  assert.ok([...routes.values()].every((list) => list.length <= 8));
  const c4a = await fixturePassages('18000', { line: '10-c4a' });
  assert.ok(c4a.length > 0 && c4a.every((p) => p.lineId === '10-c4a'));
  const timetable = await fixturePassages('17000', { realtime: false });
  assert.ok(timetable.every((p) => !p.realtime && p.delay === 0 && !p.track));
  assert.deepEqual(buildPassages({ timetable: null, station: { ids: [] }, now: NOW }), []);
});

test('the long distance: the next trains of the morning, a cancelled one', async () => {
  const sants = await fixturePassages('60000', { destination: '71801' });
  assert.deepEqual(
    sants.map((p) => [trainLabel(p), p.destination]),
    [
      ['AVE 3301', 'Barcelona-Sants'],
      ['AVE 3073', 'Figueres-Vilafant'],
      ['AVE 9725', 'Marseille St Charles'],
    ],
  );
  assert.equal(sants[0].arrival, madrid('33:24'));
  const tripId = sants[0].trip.split('@')[0];
  const cancelled = buildPassages({
    timetable: {
      services: { S: ['20261117'] },
      trips: { [tripId]: ['R', 'S', 'Barcelona-Sants', '3301', 3] },
      rows: [[tripId, '60000', 23 * 3600, 23 * 3600, 1, true, false]],
    },
    station: { ids: ['60000'] },
    realtime: index([tripUpdate(tripId, { cancelled: true })]),
    now: NOW,
  });
  assert.equal(cancelled[0].cancelled, true);
});

test('waits, the trains to come, the cancelled ones, their names', () => {
  const list = [
    passage({ time: '22:05' }),
    passage({ time: '22:10', cancelled: true }),
    passage({ time: '22:17' }),
  ];
  assert.equal(minutesLeft(list[2], NOW), 11);
  assert.equal(minutesLeft(list[0], NOW), 0);
  assert.deepEqual(
    upcomingPassages(list, NOW).map((p) => p.trip),
    ['C3-22:05', 'C3-22:17'],
  );
  assert.deepEqual(
    cancelledPassages(list, NOW).map((p) => p.trip),
    ['C3-22:10'],
  );
  assert.equal(routeOf(list[0]), '10-c3|aranjuez');
  assert.equal(trainLabel(list[0]), 'C3');
  assert.equal(trainLabel(passage({ line: 'AVE', network: 'ld', number: '3063' })), 'AVE 3063');
});
