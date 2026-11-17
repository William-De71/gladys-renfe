import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConfig,
  readLanguage,
  readInterval,
  parseLines,
  parseAddedStations,
  DEFAULT_INTERVAL,
  MAX_ADDED_STATIONS,
} from '../src/config.js';

test('stations, lines, interval and language from the raw config', () => {
  const config = normalizeConfig({
    station_1: ' Madrid-Atocha Cercanías ',
    station_1_destination: 'Aranjuez',
    station_1_line: 'C3',
    station_2: '',
    station_3: 'chamartin',
    lines: 'C3 Madrid, R2N ; c3 madrid',
    interval: '30',
    language: 'de',
  });
  assert.deepEqual(config, {
    stations: [
      { slot: 1, station: 'Madrid-Atocha Cercanías', destination: 'Aranjuez', line: 'C3' },
      { slot: 3, station: 'chamartin', destination: '', line: '' },
    ],
    addedStations: [],
    lines: ['C3 Madrid', 'R2N'],
    interval: 30,
    language: 'de',
  });
  assert.deepEqual(normalizeConfig(null), {
    stations: [],
    addedStations: [],
    lines: [],
    interval: DEFAULT_INTERVAL,
    language: 'auto',
  });
});

test('bounds: six lines, the intervals offered, the stored language', () => {
  assert.equal(parseLines('1,2,3,4,5,6,7,8').length, 6);
  assert.deepEqual(parseLines(undefined), []);
  assert.equal(readInterval(45), DEFAULT_INTERVAL);
  assert.equal(readInterval(300), 300);
  assert.equal(readLanguage({ last_language: 'es' }, 'fr'), 'es');
  assert.equal(readLanguage({ last_language: 'español' }, 'fr'), 'fr');
  assert.equal(readLanguage(undefined, 'en'), 'en');
});

test('the stations added with the buttons follow the three of the form', () => {
  const added = [
    { station: '60000', destination: '71801', line: 'ld-ave' },
    { station: ' 17000 ', destination: '', line: '' },
    { station: '', line: 'C1' },
    'Sants',
  ];
  const config = normalizeConfig({ station_2: 'Aranjuez', added_stations: added });
  assert.deepEqual(config.stations, [
    { slot: 2, station: 'Aranjuez', destination: '', line: '' },
    { slot: null, added: 1, station: '60000', destination: '71801', line: 'ld-ave' },
    { slot: null, added: 2, station: '17000', destination: '', line: '' },
  ]);
  assert.equal(config.addedStations.length, 2);
  // Stored as JSON text by an older core: read the same.
  assert.deepEqual(parseAddedStations(JSON.stringify(added)), config.addedStations);
  assert.deepEqual(parseAddedStations('not json'), []);
  assert.deepEqual(parseAddedStations(undefined), []);
  const many = Array.from({ length: 20 }, (_, n) => ({ station: `S${n}` }));
  assert.equal(parseAddedStations(many).length, MAX_ADDED_STATIONS);
});
