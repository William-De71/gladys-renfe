// The traps of the Gladys core that the fake Gladys does not catch
// (community feedback, thread 11005): a device is only polled with
// should_poll AND poll_frequency, every feature needs min / max / read_only /
// has_feedback, a wrong category / type pair shows no icon nor label, and a
// single invalid field rejects the whole discovery batch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import {
  codeKey,
  stationKey,
  followedName,
  idsOf,
  parseExternalId,
  buildStationDevice,
  buildStationStates,
  buildLineDevice,
  buildLineStates,
  lineStatusText,
  DEVICE_TYPES,
} from '../src/device.js';
import { parseTraffic, lineTraffic } from '../src/traffic.js';
import { readAlerts } from '../src/realtime.js';
import { LANGUAGES } from '../src/i18n.js';
import { fakeGladys, NOW, TZ, passage, alertC3, feedOf, madrid } from './helpers/fixtures.js';

const ATOCHA = { code: '18000', name: 'Madrid-Atocha Cercanías' };
const ARANJUEZ = { code: '60200', name: 'Aranjuez' };
const C3 = {
  id: '10-c3',
  name: 'C3',
  network: 'cer',
  nucleo: '10',
  nucleoName: 'Madrid',
  routeIds: ['10T0007C3', '10T0008C3'],
};
const R2N = {
  id: '51-r2n',
  name: 'R2N',
  network: 'cer',
  nucleo: '51',
  nucleoName: 'Rodalies de Catalunya',
  routeIds: [],
};
const AVE = { id: 'ld-ave', name: 'AVE', network: 'ld', nucleo: '', nucleoName: '', routeIds: [] };
const followed = (station, destination, line) => {
  const entry = { station, destination, line, key: stationKey(station, destination, line) };
  return { ...entry, name: followedName(entry) };
};
const TO_ARANJUEZ = followed(ATOCHA, ARANJUEZ, C3);
const CHAMARTIN = followed({ code: '17000', name: 'Madrid-Chamartín-Clara Campoamor' }, null, null);
const PASSAGES = [
  passage({ time: '22:28', delay: 1, track: '2', arrival: madrid('23:14') }),
  passage({ time: '22:59', delay: 0 }),
];
const traffic = parseTraffic(
  readAlerts(
    feedOf([
      alertC3(),
      alertC3({
        id: 'info-c4',
        routeIds: ['10T0011C4'],
        text: 'Son válidos los títulos de viaje de Cercanías en los autobuses de la EMT.',
      }),
    ]),
  ),
  { lineOfRoute: (id) => (id.endsWith('C3') ? C3 : { id: '10-c4' }) },
);

const devices = (language) => [
  buildStationDevice(fakeGladys, TO_ARANJUEZ, language),
  buildStationDevice(fakeGladys, CHAMARTIN, language),
  buildLineDevice(fakeGladys, C3, language),
  buildLineDevice(fakeGladys, R2N, language),
  buildLineDevice(fakeGladys, AVE, language),
];

// Pairs with an icon and a label in the Gladys front (front/src/utils/consts.js).
const PAIRS = [
  [DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT, undefined],
  [
    DEVICE_FEATURE_CATEGORIES.DURATION,
    DEVICE_FEATURE_TYPES.DURATION.INTEGER,
    DEVICE_FEATURE_UNITS.MINUTES,
  ],
  [DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.INTEGER, undefined],
];

test('devices are never polled by Gladys: the integration has its own timer', () => {
  for (const device of devices('en')) {
    assert.equal(device.should_poll, false, device.external_id);
    assert.equal(device.poll_frequency, undefined);
  }
});

test('every feature carries min, max, read_only and has_feedback, in every language', () => {
  for (const language of LANGUAGES) {
    for (const device of devices(language)) {
      for (const feature of device.features) {
        for (const key of ['min', 'max']) {
          assert.equal(typeof feature[key], 'number', `${feature.external_id}.${key}`);
        }
        assert.ok(feature.min <= feature.max, feature.external_id);
        assert.equal(feature.read_only, true, feature.external_id);
        assert.equal(feature.has_feedback, false, feature.external_id);
        assert.ok(feature.name.length > 0 && feature.name.length <= 255);
      }
      const names = new Set(device.features.map((feature) => feature.name));
      assert.equal(names.size, device.features.length, 'every feature has its own name');
    }
  }
});

test('category / type / unit pairs known to the Gladys front, from the SDK constants', () => {
  for (const feature of devices('en').flatMap((device) => device.features)) {
    assert.ok(
      PAIRS.some(
        ([category, type, unit]) =>
          feature.category === category && feature.type === type && feature.unit === unit,
      ),
      `${feature.external_id}: ${feature.category}/${feature.type}/${feature.unit}`,
    );
  }
});

test('ids from the codes of the stations and the line id; read back', () => {
  const [route, chamartin, c3, r2n, ave] = devices('fr');
  assert.equal(route.external_id, 'ext:renfe:station:18000_60200_10-c3');
  assert.equal(route.name, 'Renfe Madrid-Atocha Cercanías → Aranjuez (C3)');
  assert.equal(chamartin.external_id, 'ext:renfe:station:17000');
  assert.equal(chamartin.name, 'Renfe Madrid-Chamartín-Clara Campoamor');
  assert.deepEqual(
    [c3.external_id, c3.name],
    ['ext:renfe:line:10-c3', 'Renfe Cercanías Madrid C3'],
  );
  assert.deepEqual([r2n.external_id, r2n.name], ['ext:renfe:line:51-r2n', 'Renfe Rodalies R2N']);
  assert.deepEqual([ave.external_id, ave.name], ['ext:renfe:line:ld-ave', 'Renfe AVE']);
  assert.equal(codeKey('10-C4a'), '10-c4a');
  assert.equal(stationKey(ATOCHA, null, AVE), '18000_ld-ave');
  assert.deepEqual(parseExternalId('ext:renfe:station:18000_60200_10-c3:wait'), {
    type: 'station',
    key: '18000_60200_10-c3',
  });
  assert.deepEqual(parseExternalId('ext:renfe:line:10-c3'), { type: 'line', key: '10-c3' });
  assert.equal(parseExternalId('something'), null);
  assert.deepEqual(
    route.params.map((param) => [param.name, param.value]),
    [
      ['RENFE_STATION', 'Madrid-Atocha Cercanías'],
      ['RENFE_DESTINATION', 'Aranjuez'],
      ['RENFE_LINE', 'C3'],
    ],
  );
  assert.deepEqual(c3.params, [{ name: 'RENFE_LINE', value: 'Cercanías Madrid C3' }]);
});

test('station states: the next train, the two waits and the delay', () => {
  const states = buildStationStates(fakeGladys, TO_ARANJUEZ, PASSAGES, {
    language: 'fr',
    now: NOW,
    timeZone: TZ,
  });
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.state ?? s.text]),
  );
  // 22:05:03: the C3 of 22:28, 1 min late (22:29), then the one of 22:59.
  assert.equal(byKey.wait, 23);
  assert.equal(byKey.following, 53);
  assert.equal(byKey.delay, 1);
  assert.equal(byKey.next, 'C3 → Aranjuez · 23 min (+1 min de retard) · voie 2 · arr. 23:14');
  // The timetable only: no delay published, the text says it.
  const scheduled = buildStationStates(
    fakeGladys,
    TO_ARANJUEZ,
    [passage({ time: '22:10', realtime: false, line: 'AVE', network: 'ld', number: '3063' })],
    { language: 'en', now: NOW, timeZone: TZ },
  );
  assert.deepEqual(
    scheduled.map((s) => s.device_feature_external_id.split(':').pop()),
    ['next', 'wait'],
  );
  assert.equal(scheduled[0].text, 'AVE 3063 → Aranjuez · 4 min (timetable)');
  // Nothing announced: the waits are left untouched.
  const empty = buildStationStates(fakeGladys, CHAMARTIN, [], { language: 'es', now: NOW });
  assert.deepEqual(
    empty.map((s) => s.text),
    ['Ningún tren anunciado'],
  );
});

test('line states: the state with the title of the heaviest message, the count', () => {
  assert.deepEqual(
    buildLineStates(fakeGladys, C3, lineTraffic(traffic, C3.id, NOW), 'fr').map(
      (s) => s.text ?? s.state,
    ),
    [
      'Trafic perturbé : Por una incidencia en la infraestructura, los trenes de la línea C3 circulan con retrasos entre Pinto y Aranjuez.',
      1,
    ],
  );
  assert.deepEqual(
    buildLineStates(fakeGladys, AVE, lineTraffic(traffic, AVE.id, NOW), 'en').map(
      (s) => s.text ?? s.state,
    ),
    ['Normal traffic', 0],
  );
  const c4 = { ...C3, id: '10-c4', name: 'C4' };
  const [status] = buildLineStates(fakeGladys, c4, lineTraffic(traffic, c4.id, NOW), 'de');
  assert.match(status.text, /^Verkehrsinformation: Son válidos/);
  assert.equal(lineStatusText({ state: 'major', messages: [] }, 'es'), 'Servicio muy alterado');
});

test('the discovery batch and the states pass the checks of the fake host API', async (t) => {
  const gladys = createFakeGladys({});
  t.after(() => gladys.fake.shutdown());
  await gladys.connect();
  for (const language of LANGUAGES) {
    await gladys.publishDiscoveredDevices([
      buildStationDevice(gladys, TO_ARANJUEZ, language),
      buildLineDevice(gladys, C3, language),
    ]);
  }
  const [station, line] = gladys.fake.discoveredDevices;
  await gladys.fake.deviceCreated(station);
  await gladys.fake.deviceCreated(line);
  await gladys.publishStates(
    buildStationStates(gladys, TO_ARANJUEZ, PASSAGES, { language: 'en', now: NOW }),
  );
  await gladys.publishStates(buildLineStates(gladys, C3, lineTraffic(traffic, C3.id, NOW), 'en'));
  assert.equal(idsOf(gladys, DEVICE_TYPES.STATION, TO_ARANJUEZ.key).device, station.external_id);
  assert.equal(idsOf(gladys, DEVICE_TYPES.LINE, C3.id).device, line.external_id);
  assert.equal(gladys.fake.lastState(`${station.external_id}:wait`), 23);
  assert.equal(gladys.fake.lastState(`${line.external_id}:messages`), 1);
});
