# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [0.1.0] - 2026-11-17

### Added

- One device per followed Renfe station (three in the form and up to 10 more with the "Add a station" button, typed by name or by code), optionally towards a destination station and for one line (a Cercanías line or a long distance product such as AVE): the next train as text with its track and its arrival time, the wait of the next two trains and the delay of the next one, from the timetable corrected in real time.
- Long and medium distance trains (AVE, Avlo, Alvia, Intercity, Regional, Avant) and the Cercanías and Rodalies of every núcleo, read from the two official GTFS of Renfe and merged on the station codes of Adif.
- One device per followed Cercanías line (up to six): its traffic state worked out from the alerts of Renfe (normal, traffic information, disrupted, heavily disrupted) and the number of traffic messages under way.
- Scene triggers: departure soon (2 to 30 minutes before, on the real-time estimate), train late (5 to 60 minutes), train cancelled, line disrupted, back to normal, and a new traffic message about a followed line.
- Scene actions: read the next trains of a station (with the delay, the track and the arrival), and read the traffic of a line, each with a ready-made sentence.
- Dashboard widgets: the next trains of one or several stations, like the departure boards, with cancelled trains and delays highlighted (any station can be typed in the widget); the traffic of Cercanías lines with the full messages and their period, the lines of the followed stations by default.
- Configuration actions: test the connection, find a station by name (with its code and its lines), add, list and remove stations, and a diagnostic written to the Logs tab.
- Cloud transport: the official open data of Renfe (CC BY 4.0), no account and no key; the two GTFS downloaded only when Renfe publishes new ones, kept in /data and streamed within 256 MB; the GTFS-RT real time of the networks of the followed stations in one request each, every 30 seconds to 5 minutes, and the alerts every 5 minutes.
- English, French, German and Spanish everywhere: settings, devices, widgets, scenes and documentation.

[0.1.0]: https://github.com/William-De71/gladys-renfe/releases/tag/v0.1.0
