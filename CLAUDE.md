# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Renfe, the Spanish trains: the
long and medium distance (AVE, Avlo, Alvia, Intercity, Regional, Avant…) and
the Cercanías and Rodalies of every núcleo. A Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the official open data of Renfe (no
key, CC BY 4.0): the two timetables (GTFS zips on ssl.renfe.com, 0.7 MB for
the long distance and 15 MB for the Cercanías, kept in /data; a daily HEAD
compares their size and date — the servers of Renfe date one file a few
seconds apart, so do their ETags — and a zip is downloaded only when it
changed), the GTFS-RT trip updates of each network (JSON on
gtfsrt.renfe.com, one request per network for every followed station), the
vehicle positions of the
Cercanías (their track) and the alerts of the Cercanías. The trains of the
followed stations — three in the form, up to 10 more added with the "Add a
station" button, each with an optional destination station and line — come
from the timetables corrected by the real time.
Transport: cloud only.
Datasets: https://data.renfe.com/

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/widgets.test.js          # one file
DEBUG=gladys-integration-sdk npm test     # with the SDK debug logs
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store . --skip-image-check   # store checks
scripts/build-cover.sh                    # cover.jpg from docs/assets/cover.svg
docs/illustrations/render.sh              # docs/assets/widgets.<lang>.png
node .github/scripts/release.mjs next     # the version the next release would get
```

## Architecture

```
index.js                SDK wiring only (new GladysIntegration + createApp)
src/app.js              every handler, registered before connect(); the timers
src/renfe-api.js        HTTP client: the two GTFS (HEAD, size + date), the JSON feeds (busy asked again), errors
src/realtime.js         the GTFS-RT JSON feeds: trip updates, vehicle positions (tracks), alerts
src/gtfs.js             the GTFS zips (central directory + zlib, trips and stop_times streamed, cells trimmed)
src/network.js          stations (both GTFS merged on the Adif codes), lines (products, Cercanías by núcleo), timetable
src/departures.js       timetable + trip updates -> trains (real time, delay, cancelled, track, arrival)
src/traffic.js          alerts -> messages (title, periods, weight from Spanish words), the state of a line
src/events.js           scene trigger transitions, payloads, scene action outputs
src/device.js           the station and line devices and their states
src/widgets.js          departures and traffic dashboard widgets
src/store.js            /data/renfe.json: network, `seen` (the zips: /data/renfe-ld.zip, renfe-cer.zip)
src/time.js             Madrid wall-clock times, times of day (TZ), the service day
src/config.js           configuration (three stations + `added_stations`, lines, interval, language)
src/i18n.js             runtime texts, en / fr / de / es
gladys-assistant-integration.json   manifest
docs/{en,fr,de,es}.md   user documentation, re-hosted by the store
docs/illustrations/     generated widget images (render.sh, gen.mjs, render.js)
test/fixtures/          real open data of Renfe, reduced (CC BY 4.0): two GTFS, four feeds (2026-11-17 22:05, a strike)
test/helpers/           the fake Renfe: a zip writer, feed builders, fetch
.github/scripts/release.mjs         version, changelog, bump (tested in test/)
```

## Rules

- **External ids are forever**, and so is every key users store: device and
  feature external ids (`station:<code>[_<destination code>][_<line id>]`,
  e.g. `station:18000_60200_10-c3`, `station:17000`; `line:<line id>`, e.g.
  `line:10-c3`, `line:ld-ave`; the station codes are the stop ids of Renfe,
  the codes of Adif; a Cercanías line id is the two first digits of its route
  ids (the núcleo) and its short name in lower case, a long distance one
  `ld-` and the slug of its product), feature `category` / `type` / `unit` /
  `min` / `max` / `step`, the keys of `config_schema`, `actions`, the widgets
  and their settings, scene triggers (fields, options, variables) and scene
  actions (fields, outputs), and the internal config keys `added_stations`
  (`[{ station, destination, line }]`, stored as station codes and line ids)
  and `last_language`. `test/structure.test.js` compares them to
  `test/fixtures/discovery.baseline.json`: never update the baseline to make a
  test pass without a documented migration.
- **Category / type pairs.** The next train and the line traffic are `text` /
  `text`, the waits and the delay `duration` / `integer` in minutes (0-180,
  0-300), the count of messages `counter-sensor` / `integer` (0-20). Without a
  train the waits are not published (a 0 would announce a train now); without
  real time the delay is not published.
- **`should_poll` stays false**: the integration reads on its own timer — the
  trip updates of the networks of the followed stations in ONE request per
  network every `interval` (30 s to 5 min, 1 min by default; 10 min while no
  station announces anything in the next half hour), with the vehicle
  positions when a Cercanías line is concerned; the alerts every 5 min; the
  timetables daily after 06:00 (Renfe publishes the Cercanías one at about
  03:15 UTC), downloaded only when their size changed or their date moved
  by more than 30 minutes, asked again 30 min later after a failure. A widget
  or a scene action reuses a reading of less than 90 s.
- **Memory.** The container has 256 MB: stop_times.txt of the Cercanías (272
  MB inflated) and trips.txt are inflated as streams, never held whole; only
  the trips of the services running in the window (two weeks for the lines of
  each station, eight days for the timetable) and the rows of the followed
  stations are kept; the zip of a network is read only when a followed
  station has a line of it; the heap is bounded in the Dockerfile (a real
  reading peaks at about 170 MB RSS).
- **Times.** GTFS times count from the noon of the service day in Madrid
  minus 12 hours (`serviceStart()`), beyond 24:00 after midnight; GTFS-RT
  times are Unix seconds. Never parse a GTFS time as a wall-clock time.
- **Real time.** A trip update is matched by trip id (the GTFS and the
  GTFS-RT share them). Renfe sends, per train under way, ONE station (the
  next one) with its estimate and delay: a station without its own estimate
  takes the delay of the announced station before it. An early estimate counts
  on time. Renfe names a trip without its date and a long distance trip id
  runs for weeks: a cancellation or a skipped station counts for the runs
  between 12 hours ago and 6 hours ahead only. A cancelled train or a skipped
  station is a cancelled passage (left out of the waits, shown in the widget,
  fired once by `departure_cancelled`). Trips ADDED by Renfe are left out (no
  timetable). Without a trip update, the timetable only (say it:
  "(timetable)"). Never invent a delay. The destination of a train is its last
  station (the headsigns say "CIVIS", a kind of service).
- **Traffic.** Alerts exist for the Cercanías only. The state of a line is
  its heaviest alert under way: by its effect when set (Renfe sets none),
  else by its Spanish words, accents aside (`traffic.js`); lifts and entrances
  are information; a message about one train ("Tren con salida…") is never
  heavier than disrupted; `normal` without one. The routes of the two
  directions of a line are one line. Alerts about a station only are left out.
  The Basque half of a bilingual text ("… // …") and the opening tags
  ("#MadC5") are dropped; a heading too short ("Línea C1.") joins the next
  sentence in the title.
- **Events once.** `seen` (in /data) remembers the reminders fired, the delays
  and the cancellations reported per station, the state and messages of each
  followed line. The first reading of a station or a line is a baseline:
  nothing fires. A scene action or a widget never fires an event.
- **Data licence.** CC BY 4.0: keep "Renfe" and the time of the reading
  visible in the widgets, and the credit (Renfe, data.renfe.com) in the
  README, the docs and NOTICE.
- **The container rootfs is read-only.** Write only under `/data`.
- **Four languages.** Every user-facing text (manifest, runtime messages in
  `src/i18n.js`, `docs/*.md`, README) exists in English, French, German and
  Spanish. `test/i18n.test.js` checks it. Names of stations, destinations and
  the traffic messages stay in Spanish.
- **Widget images.** After any change to the content of a widget, run
  `docs/illustrations/render.sh` again and look at the four PNG files.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, the lockfile or the manifest, nor the `docker_image` tag.
  The version stays below 1.0.0 until the maintainer runs the Release workflow
  with `release-as: 1.0.0`.
- **Changelog.** Never edit CHANGELOG.md by hand, it is generated at the
  release. Write the PR title as the line the user will read.
- **Commits and PR titles** follow Conventional Commits, in English: `feat` ->
  minor, `fix` / `perf` -> patch, `!` or `BREAKING CHANGE:` -> major (minor
  below 1.0.0); `docs`, `chore`, `ci`, `test`, `style`, `refactor`, `build`
  release nothing.
- **Manifest.** Texts are objects `{ "en", "fr", "de", "es" }`; the catalog
  `description` holds 10 to 100 characters per language; the file stays under
  100 KB. `gladys_version` is `>=5.3.0` (widgets, scene triggers, catalog
  `keywords` and `countries`). Transport: `["cloud"]`. No permission, no
  secret.
- **Forum drafts** (`.github/forum-*.md`) are never committed.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the fake API of
  `test/helpers/fixtures.js`).
