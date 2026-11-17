import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRenfeClient,
  sameVersion,
  USER_AGENT,
  BUSY_RETRIES,
  ENDPOINTS,
} from '../src/renfe-api.js';
import { fakeRenfe, LAST_MODIFIED, GTFS_ZIPS } from './helpers/fixtures.js';

/**
 * @description A client on the fake Renfe.
 * @returns {object} `{ api, fetch, pauses }`.
 */
function client() {
  const fetch = fakeRenfe();
  const pauses = [];
  const api = createRenfeClient({
    fetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  return { api, fetch, pauses };
}

test('the feeds in JSON, with the user agent of the integration', async () => {
  const seen = [];
  const api = createRenfeClient({
    fetch: async (url, init) => {
      seen.push([url, init.headers['user-agent']]);
      return Response.json({ header: {}, entity: [] });
    },
  });
  assert.deepEqual(await api.tripUpdates('ld'), { timestamp: null, tripUpdates: [] });
  await api.tripUpdates('cer');
  await api.alerts();
  assert.equal((await api.vehicles()).size, 0);
  assert.deepEqual(
    seen.map(([url]) => url),
    [
      'https://gtfsrt.renfe.com/trip_updates_LD.json',
      'https://gtfsrt.renfe.com/trip_updates.json',
      'https://gtfsrt.renfe.com/alerts.json',
      'https://gtfsrt.renfe.com/vehicle_positions.json',
    ],
  );
  assert.ok(seen.every(([, agent]) => agent === USER_AGENT));
  assert.match(USER_AGENT, /^gladys-renfe\/\d+\.\d+\.\d+ /);
});

test('a zip is downloaded only when its size or its date changed', async () => {
  const { api, fetch } = client();
  const first = await api.gtfs('ld');
  const version = `${GTFS_ZIPS.ld.length}@${Date.parse(LAST_MODIFIED.ld)}`;
  assert.equal(first.lastModified, version);
  assert.equal(first.zip.length, GTFS_ZIPS.ld.length);
  assert.equal(await api.gtfs('ld', version), null);
  // Another server of Renfe dates the same file one second earlier.
  fetch.state.lastModified.ld = 'Tue, 17 Nov 2026 00:05:39 GMT';
  assert.equal(await api.gtfs('ld', version), null);
  assert.equal(api.requests.notModified, 2);
  assert.deepEqual(
    fetch.calls.map((call) => call.method),
    ['GET', 'HEAD', 'HEAD'],
  );
  // The zip of the next night.
  fetch.state.lastModified.ld = 'Wed, 18 Nov 2026 00:05:41 GMT';
  const next = await api.gtfs('ld', version);
  assert.equal(
    next.lastModified,
    `${GTFS_ZIPS.ld.length}@${Date.parse('Wed, 18 Nov 2026 00:05:41 GMT')}`,
  );
  assert.equal(api.requests.byEndpoint[ENDPOINTS.GTFS_LD], 5);
  assert.equal(sameVersion('1@0', '2@0'), false);
  assert.equal(sameVersion('"etag"', '"etag"'), true);
  assert.equal(sameVersion('', ''), false);
});

test('errors: busy asked again once, unreachable, invalid', async () => {
  const { api, fetch, pauses } = client();
  fetch.state.busy = BUSY_RETRIES;
  assert.ok((await api.alerts()).alerts.length > 0);
  assert.deepEqual(pauses, [5000]);
  fetch.state.busy = BUSY_RETRIES + 1;
  await assert.rejects(api.alerts(), { kind: 'busy', status: 503 });
  fetch.state.fail = 'network';
  await assert.rejects(api.tripUpdates('cer'), { kind: 'unreachable', message: 'ECONNREFUSED' });
  fetch.state.fail = 404;
  await assert.rejects(api.gtfs('cer'), { kind: 'invalid', status: 404 });
  const broken = createRenfeClient({ fetch: async () => new Response('<html>oops</html>') });
  await assert.rejects(broken.alerts(), { kind: 'invalid' });
  assert.equal(broken.requests.failed, 1);
});
