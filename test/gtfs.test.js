import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zipEntries,
  readEntry,
  splitCsvLine,
  eachRow,
  gtfsSeconds,
  serviceDates,
  trainNumber,
  readGtfs,
} from '../src/gtfs.js';
import { GTFS_ZIPS, makeZip } from './helpers/fixtures.js';

test('a zip, deflated or stored, read through its central directory', async () => {
  for (const store of [false, true]) {
    const zip = makeZip({ 'a.txt': 'héllo', 'dir/b.txt': 'b' }, { store });
    const entries = zipEntries(zip);
    assert.deepEqual([...entries.keys()], ['a.txt', 'b.txt']);
    assert.equal((await readEntry(zip, entries, 'a.txt')).toString('utf8'), 'héllo');
    assert.equal(await readEntry(zip, entries, 'none.txt'), null);
  }
  assert.throws(() => zipEntries(Buffer.from('not a zip at all, not at all')), {
    kind: 'invalid',
  });
});

test('CSV: quotes, CRLF, a byte order mark, the padding of Renfe', () => {
  assert.deepEqual(splitCsvLine('a,"b, c",d'), ['a', 'b, c', 'd']);
  assert.deepEqual(splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
  const rows = [];
  eachRow(
    Buffer.from('﻿id,name   \r\n1,"Sants, Barcelona"\r\n\r\n10T0001C1  ,C1        \r\n'),
    (row, column) => rows.push([row[column('id')], row[column('name')]]),
  );
  assert.deepEqual(rows, [
    ['1', 'Sants, Barcelona'],
    ['10T0001C1', 'C1'],
  ]);
  eachRow(null, () => assert.fail('no row'));
});

test('GTFS times beyond midnight; the dates of the services; the train numbers', () => {
  assert.equal(gtfsSeconds('06:43:00'), 6 * 3600 + 43 * 60);
  assert.equal(gtfsSeconds('8:30:00'), 8 * 3600 + 30 * 60);
  assert.equal(gtfsSeconds('25:10:30'), 25 * 3600 + 10 * 60 + 30);
  assert.equal(gtfsSeconds('soon'), null);
  const calendar = Buffer.from(
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      'WEEK,1,1,1,1,1,0,0,20261101,20261231\n',
  );
  const dates = Buffer.from(
    'service_id,date,exception_type\nWEEK,20261118,2\nSUN,20261122,1\nOLD,20250101,1\n',
  );
  assert.deepEqual(Object.fromEntries(serviceDates(calendar, dates, '20261116', '20261123')), {
    WEEK: ['20261116', '20261117', '20261119', '20261120', '20261123'],
    SUN: ['20261122'],
  });
  assert.equal(trainNumber('03063', '0306312026-11-16', 'x'), '3063');
  assert.equal(trainNumber('', '1020M19799C1', '1020M'), '19799');
  assert.equal(trainNumber('', 'odd', '1020M'), '');
});

test('the long distance GTFS: products, stations, trains with their number', async () => {
  const reference = await readGtfs(GTFS_ZIPS.ld);
  assert.ok(reference.routes.length > 50);
  assert.deepEqual([...new Set(reference.routes.map((route) => route.shortName))].sort(), [
    'AVANT',
    'AVANT EXP',
    'AVE',
    'AVE Euromed',
    'AVLO',
    'Intercity',
    'Regional',
  ]);
  assert.equal(reference.timetable, null);
  const sants = reference.stops.find((stop) => stop.id === '71801');
  assert.equal(sants.name, 'Barcelona-Sants');
  const { timetable } = await readGtfs(GTFS_ZIPS.ld, {
    stopIds: new Set(['60000', '71801']),
    from: '20261117',
    to: '20261118',
  });
  const [tripId] = Object.keys(timetable.trips).filter((id) => id.startsWith('03301'));
  // AVE 3301: Madrid 06:16, Barcelona-Sants 09:24, its last station.
  assert.deepEqual(timetable.trips[tripId].slice(2), ['Barcelona-Sants', '3301', 3]);
  const calls = timetable.rows.filter((row) => row[0] === tripId);
  assert.deepEqual(
    calls.map((row) => row.slice(1)),
    [
      ['60000', 6 * 3600 + 16 * 60, 6 * 3600 + 16 * 60, 1, true, false],
      ['71801', 9 * 3600 + 24 * 60, 9 * 3600 + 24 * 60, 3, false, true],
    ],
  );
});

test('the Cercanías GTFS: padded routes, last station as destination ("CIVIS")', async () => {
  const reference = await readGtfs(GTFS_ZIPS.cer);
  const c1 = reference.routes.find((route) => route.id === '10T0001C1');
  assert.deepEqual(c1, {
    id: '10T0001C1',
    shortName: 'C1',
    longName: 'Principe Pio - Aeropuerto-T4',
    type: 2,
    color: '75B6E0',
  });
  const { timetable } = await readGtfs(GTFS_ZIPS.cer, {
    stopIds: new Set(['18000']),
    from: '20261117',
    to: '20261118',
  });
  assert.ok(timetable.rows.length > 20);
  const trip = timetable.trips['1020M20108C3'];
  assert.deepEqual(trip.slice(0, 4), ['10T0007C3', '1020M', 'Aranjuez', '20108']);
  assert.deepEqual(timetable.services['1020M'], ['20261117']);
});

test('trips.txt streamed, only the trips of the services running in the window', async () => {
  // Wednesday only: the C3 of the evening of Tuesday (service 1020M) is skipped.
  const one = await readGtfs(GTFS_ZIPS.cer, {
    stopIds: new Set(['18000']),
    from: '20261118',
    to: '20261118',
  });
  assert.ok(one.timetable.rows.length > 0);
  assert.ok(!Object.keys(one.timetable.trips).some((id) => id.startsWith('1020M')));
  const none = await readGtfs(GTFS_ZIPS.cer, { from: '20250101', to: '20250102' });
  assert.deepEqual(none.linesByStop, {});
});

test('a GTFS without its files is refused', async () => {
  await assert.rejects(readGtfs(makeZip({ 'agency.txt': 'agency_id\n1071\n' })), {
    kind: 'invalid',
  });
});
