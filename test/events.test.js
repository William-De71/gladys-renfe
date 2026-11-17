// Scene triggers fire once per transition, with flat payloads within the
// limits of the core; scene actions return their declared outputs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  tolerance,
  TRIGGERS,
  REMINDER_MINUTES,
  NEXT_DEPARTURES_OUTPUTS,
  LINE_TRAFFIC_OUTPUTS,
} from '../src/events.js';
import { parseTraffic, lineTraffic } from '../src/traffic.js';
import { readAlerts } from '../src/realtime.js';
import { LANGUAGES } from '../src/i18n.js';
import { NOW, TZ, passage, alertC3, feedOf, madrid } from './helpers/fixtures.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const FOLLOWED = {
  name: 'Madrid-Atocha Cercanías → Aranjuez',
  deviceId: 'ext:renfe:station:18000_60200',
  station: { code: '18000', name: 'Madrid-Atocha Cercanías' },
};
const C3 = {
  id: '10-c3',
  name: 'C3',
  network: 'cer',
  nucleo: '10',
  nucleoName: 'Madrid',
  deviceId: 'ext:renfe:line:10-c3',
};
const C4 = { ...C3, id: '10-c4', name: 'C4', deviceId: 'ext:renfe:line:10-c4' };
const MINUTE = 60 * 1000;
const lineOfRoute = (id) => (id.endsWith('C3') ? C3 : C4);
const disrupted = (alerts = [alertC3()]) =>
  parseTraffic(readAlerts(feedOf(alerts)), { lineOfRoute });
const normal = disrupted([]);

/**
 * @description Assert that event data is flat and within the limits of the core.
 * @param {object} data - The data.
 * @param {string} key - The trigger key.
 */
function assertPayload(data, key) {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === key);
  assert.ok(trigger, key);
  assert.ok(Object.keys(data).length <= 30);
  for (const [name, value] of Object.entries(data)) {
    assert.ok(
      value === null || ['string', 'number', 'boolean'].includes(typeof value),
      `${key}.${name}`,
    );
    if (typeof value === 'string') {
      assert.ok(value.length <= 1000, `${key}.${name}`);
    }
  }
  // Every variable is in the data, and every field filters a key of it.
  for (const variable of trigger.variables) {
    assert.ok(variable.key in data, `${key}: variable ${variable.key}`);
  }
  for (const field of trigger.fields) {
    assert.ok(field.key in data, `${key}: field ${field.key}`);
  }
}

test('reminders: once per train and mark, never on the first reading', () => {
  // 22:09:43 in Madrid: 4 min 40 s after 22:05:03.
  const passages = [passage({ time: '22:09:43', trip: 'T1@20261117' })];
  const first = detectReminders({ passages, fired: undefined, now: NOW });
  assert.deepEqual(first.due, []);
  assert.equal(first.fired.length, 1);
  const memory = detectReminders({ passages, fired: [], now: NOW });
  assert.deepEqual(
    memory.due.map((entry) => entry.mark),
    [5],
  );
  assert.deepEqual(detectReminders({ passages, fired: memory.fired, now: NOW + 10000 }).due, []);
  // The same trip announced later (a delay) is the same train: no new 5.
  const later = [passage({ time: '22:09:43', delay: 1, trip: 'T1@20261117' })];
  assert.deepEqual(detectReminders({ passages: later, fired: memory.fired, now: NOW }).due, []);
  const forgotten = detectReminders({ passages: [], fired: memory.fired, now: NOW + 20 * MINUTE });
  assert.deepEqual(forgotten.fired, []);
  assert.deepEqual(REMINDER_MINUTES.map(tolerance), [1, 1, 1.5, 3, 3, 3, 5]);
});

test('delays: once per train and mark reached, within two hours, never on the first reading', () => {
  const passages = [
    passage({ time: '22:28', delay: 12, trip: 'D1' }),
    passage({ time: '22:40', delay: 3, trip: 'D2' }),
    passage({ time: '24:20', delay: 40, trip: 'D3' }),
    passage({ time: '22:30', delay: 0, realtime: false, trip: 'D4' }),
  ];
  assert.deepEqual(detectDelays({ passages, known: undefined, now: NOW }).due, []);
  const first = detectDelays({ passages, known: [], now: NOW });
  assert.deepEqual(
    first.due.map(({ passage: p, mark }) => [p.trip, mark]),
    [
      ['D1', 5],
      ['D1', 10],
    ],
  );
  // Later 20 minutes late: the 15 mark only.
  const worse = [passage({ time: '22:28', delay: 20, trip: 'D1' })];
  assert.deepEqual(
    detectDelays({ passages: worse, known: first.known, now: NOW }).due.map(({ mark }) => mark),
    [15],
  );
  for (const language of LANGUAGES) {
    assertPayload(
      delayedData(FOLLOWED, first.due[1].passage, 10, { language, timeZone: TZ }),
      TRIGGERS.DEPARTURE_DELAYED,
    );
  }
  const data = delayedData(FOLLOWED, first.due[1].passage, 10, { language: 'es', timeZone: TZ });
  assert.deepEqual(
    [data.minutes, data.time, data.expected_time, data.delay_minutes, data.train_number],
    ['10', '22:28', '22:40', 12, '23525'],
  );
  assert.equal(
    data.summary,
    'El C3 de las 22:28 con destino Aranjuez desde Madrid-Atocha Cercanías lleva 12 min de retraso: sale a las 22:40.',
  );
});

test('cancellations: once per train, within two hours, never on the first reading', () => {
  const passages = [
    passage({ time: '22:18', cancelled: true, trip: 'C1' }),
    passage({ time: '24:22', cancelled: true, trip: 'C2' }),
    passage({ time: '22:23', trip: 'C3' }),
  ];
  assert.deepEqual(detectCancellations({ passages, known: undefined, now: NOW }).due, []);
  const first = detectCancellations({ passages, known: [], now: NOW });
  assert.deepEqual(
    first.due.map((entry) => entry.trip),
    ['C1'],
  );
  assert.deepEqual(detectCancellations({ passages, known: first.known, now: NOW }).due, []);
  for (const language of LANGUAGES) {
    assertPayload(
      cancelledData(FOLLOWED, first.due[0], { language, timeZone: TZ }),
      TRIGGERS.DEPARTURE_CANCELLED,
    );
  }
  const ave = passage({
    time: '22:18',
    cancelled: true,
    line: 'AVE',
    network: 'ld',
    number: '3301',
    destination: 'Barcelona-Sants',
  });
  assert.equal(
    cancelledData(FOLLOWED, ave, { language: 'fr', timeZone: TZ }).summary,
    'Le AVE 3301 de 22:18 vers Barcelona-Sants au départ de Madrid-Atocha Cercanías est supprimé.',
  );
});

test('departure soon: a flat payload, its summary in every language', () => {
  const late = passage({ time: '22:10', delay: 3, track: '2' });
  for (const language of LANGUAGES) {
    const data = reminderData(FOLLOWED, late, 5, { language, timeZone: TZ });
    assertPayload(data, TRIGGERS.DEPARTURE_SOON);
    assert.deepEqual(
      [data.minutes, data.time, data.delay_minutes, data.track],
      ['5', '22:13', 3, '2'],
    );
  }
  assert.equal(
    reminderData(FOLLOWED, late, 5, { language: 'fr', timeZone: TZ }).summary,
    'C3 vers Aranjuez part de Madrid-Atocha Cercanías dans 5 min (22:13, 3 min de retard).',
  );
  assert.equal(
    reminderData(FOLLOWED, passage({ time: '22:10' }), 5, { language: 'en', timeZone: TZ }).summary,
    'C3 to Aranjuez leaves Madrid-Atocha Cercanías in 5 min (22:10).',
  );
});

test('line changes: disrupted, a new message, back to normal', () => {
  const first = detectLineChanges({ lines: [C3, C4], traffic: disrupted(), seen: {}, now: NOW });
  assert.deepEqual(first.changes, []);
  assert.equal(first.seen['10-c3'].state, 'disrupted');
  const before = detectLineChanges({ lines: [C3], traffic: normal, seen: {}, now: NOW - MINUTE });
  const now = detectLineChanges({ lines: [C3], traffic: disrupted(), seen: before.seen, now: NOW });
  assert.deepEqual(
    now.changes.map((change) => [change.key, change.message?.state]),
    [
      [TRIGGERS.LINE_DISRUPTED, 'disrupted'],
      [TRIGGERS.TRAFFIC_MESSAGE, 'disrupted'],
    ],
  );
  const same = detectLineChanges({ lines: [C3], traffic: disrupted(), seen: now.seen, now: NOW });
  assert.deepEqual(same.changes, []);
  const coming = detectLineChanges({
    lines: [C3],
    traffic: disrupted([
      alertC3(),
      alertC3({
        id: 'SOON',
        text: 'Refuerzo de trenes por el concierto en el Wizink Center.',
        periods: [
          { start: String(NOW / 1000 + 2 * 86400), end: String(NOW / 1000 + 2 * 86400 + 4 * 3600) },
        ],
      }),
    ]),
    seen: same.seen,
    now: NOW,
  });
  assert.deepEqual(
    coming.changes.map((change) => [change.key, change.message.id, change.message.state]),
    [[TRIGGERS.TRAFFIC_MESSAGE, 'SOON', 'info']],
  );
  const over = detectLineChanges({ lines: [C3], traffic: normal, seen: coming.seen, now: NOW });
  assert.deepEqual(
    over.changes.map((change) => [change.key, change.traffic.state]),
    [[TRIGGERS.LINE_RESTORED, 'normal']],
  );
});

test('line events: flat payloads, summaries in every language', () => {
  const traffic = lineTraffic(disrupted(), C3.id, NOW);
  const [message] = traffic.messages;
  for (const language of LANGUAGES) {
    for (const key of [TRIGGERS.LINE_DISRUPTED, TRIGGERS.TRAFFIC_MESSAGE]) {
      assertPayload(
        lineEvent({ key, line: C3, traffic, message }, { language, timeZone: TZ }).data,
        key,
      );
    }
    const restored = lineEvent(
      { key: TRIGGERS.LINE_RESTORED, line: C4, traffic: lineTraffic(normal, C4.id, NOW) },
      { language, timeZone: TZ },
    );
    assertPayload(restored.data, TRIGGERS.LINE_RESTORED);
  }
  const fresh = lineEvent(
    { key: TRIGGERS.TRAFFIC_MESSAGE, line: C3, traffic, message },
    { language: 'en', timeZone: TZ },
  );
  assert.deepEqual(
    [fresh.data.line, fresh.data.line_name, fresh.data.kind, fresh.data.start, fresh.data.end],
    ['ext:renfe:line:10-c3', 'Cercanías Madrid C3', 'disrupted', '17/11 21:05', ''],
  );
  assert.match(fresh.data.summary, /^Cercanías Madrid C3, disruption: Por una incidencia/);
  const event = lineEvent(
    { key: TRIGGERS.LINE_DISRUPTED, line: C3, traffic, message },
    { language: 'fr', timeZone: TZ },
  );
  assert.match(event.data.summary, /^Cercanías Madrid C3 : Trafic perturbé \(Por una incidencia/);
});

test('scene action outputs: declared keys only, flat values', () => {
  const declared = (key) =>
    manifest.scene_actions.find((action) => action.key === key).outputs.map((output) => output.key);
  assert.deepEqual(NEXT_DEPARTURES_OUTPUTS, declared('get_next_departures'));
  assert.deepEqual(LINE_TRAFFIC_OUTPUTS, declared('get_line_traffic'));
  const passages = [
    passage({ time: '22:10', delay: 2, track: '4', arrival: madrid('22:57') }),
    passage({ time: '22:27', realtime: false }),
  ];
  const next = pick(
    nextDeparturesOutputs({ followed: FOLLOWED, passages, now: NOW, language: 'en', timeZone: TZ }),
    NEXT_DEPARTURES_OUTPUTS,
  );
  assert.deepEqual(
    [
      next.found,
      next.line,
      next.train_number,
      next.minutes,
      next.time,
      next.arrival_time,
      next.track,
      next.realtime,
      next.delay_minutes,
      next.following_minutes,
    ],
    [true, 'C3', '23525', 6, '22:12', '22:57', '4', true, 2, 21],
  );
  assert.equal(
    next.summary,
    'Next train from Madrid-Atocha Cercanías: C3 to Aranjuez in 6 min. The following one in 21 min.',
  );
  const none = nextDeparturesOutputs({
    followed: FOLLOWED,
    passages: [],
    now: NOW,
    language: 'en',
    timeZone: TZ,
  });
  assert.deepEqual([none.found, none.minutes, none.time, none.arrival_time], [false, -1, '', '']);
  assert.equal(none.summary, 'No train announced from Madrid-Atocha Cercanías.');
  const traffic = lineTrafficOutputs({
    line: C3,
    traffic: lineTraffic(disrupted(), C3.id, NOW),
    language: 'fr',
  });
  assert.deepEqual(
    [
      traffic.line_name,
      traffic.state,
      traffic.disrupted,
      traffic.message_count,
      traffic.state_label,
    ],
    ['Cercanías Madrid C3', 'disrupted', true, 1, 'Trafic perturbé'],
  );
  for (const value of [...Object.values(next), ...Object.values(traffic)]) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value));
  }
});
