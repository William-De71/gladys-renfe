// Builds the widget contents of the illustrations with the integration's own
// code: node gen.mjs <repo> <out.json> (run by render.sh)
//
// The two widgets on a real evening in Madrid: the open data of Renfe read on
// 2026-11-17 at 22:05 (the evening of a railway strike) and kept in
// test/fixtures (the GTFS of Madrid-Chamartín and the trip updates, tracks
// and alerts of that minute) go through the real code (src/gtfs.js,
// src/departures.js, src/traffic.js) and the real widget builders
// (src/widgets.js). Added to show what the widgets do: a cancelled C4a, and
// works on the C5 coming in two days.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repo, out] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(`${repo}/${path}`).href);
const { buildDeparturesWidget, buildTrafficWidget } = await load('src/widgets.js');
const { parseTraffic, lineTraffic } = await load('src/traffic.js');
const { readAlerts } = await load('src/realtime.js');
const { LANGUAGES } = await load('src/i18n.js');
const { NOW, TZ, ALERTS, alertC3, fixturePassages, fixtureNetwork } = await load(
  'test/helpers/fixtures.js',
);
const manifest = JSON.parse(readFileSync(`${repo}/gladys-assistant-integration.json`, 'utf8'));

const passages = await fixturePassages('17000');
// The second C4a towards Parla cancelled.
const c4a = passages.filter((p) => p.lineId === '10-c4a' && p.destination === 'Parla');
if (c4a[1]) {
  c4a[1].cancelled = true;
}
const day = 24 * 3600;
const now = NOW / 1000;
const { lines: known } = await fixtureNetwork();
const lineOfRoute = (id) => known.find((line) => line.routeIds.includes(id)) ?? null;
const feed = readAlerts(ALERTS);
feed.alerts.push(
  readAlerts({
    entity: [
      alertC3({
        id: 'c5-works',
        routeIds: ['10T0017C5', '10T0018C5'],
        text: '#MadC5 Por obras de Adif entre Atocha y Villaverde Alto, los días 19 y 20 de noviembre los trenes de la línea C5 circularán con frecuencias de paso modificadas.',
        periods: [{ start: String(now + 2 * day - 20 * 3600), end: String(now + 3 * day) }],
      }),
    ],
  }).alerts[0],
);
const traffic = parseTraffic(feed, { lineOfRoute });
const lines = ['10-c3', '10-c4a', '10-c5', '10-c8a'].map((id) => {
  const line = known.find((entry) => entry.id === id);
  return { line, traffic: lineTraffic(traffic, id, NOW) };
});

const contents = {};
for (const language of LANGUAGES) {
  contents[language] = {
    departures: buildDeparturesWidget({
      title: 'Madrid-Chamartín-Clara Campoamor',
      passages,
      readAt: NOW,
      count: 6,
      language,
      now: NOW,
      timeZone: TZ,
    }),
    traffic: buildTrafficWidget({
      lines,
      readAt: NOW - 2 * 60 * 1000,
      language,
      now: NOW,
      timeZone: TZ,
    }),
  };
}
const widgets = Object.fromEntries(
  manifest.widgets.map((w) => [w.key, { icon: w.icon, label: w.label }]),
);
writeFileSync(out, JSON.stringify({ now: NOW, widgets, contents }));
