// -----------------------------------------------------------------------------
// Dashboard widgets of the Renfe integration.
//
//   - `departures`  the next trains of a station, like the departure boards,
//                   compact: one row per line and destination, its next
//                   trains on one line — 3 · 18 · 33 min, a cancelled train as
//                   "suprimido 21:44", the row in orange when the next one is
//                   late or a train is cancelled. A followed station (chosen
//                   among the devices), several (the devices of one station
//                   merged, a row per station otherwise), or any station typed
//                   in the widget settings (with an optional line);
//   - `traffic`     the state of Cercanías lines — normal, information,
//                   disrupted, heavily disrupted — then their messages under
//                   way and coming; a tap opens the full text. The followed
//                   lines, the ones typed in the settings, or by default the
//                   Cercanías lines of the followed stations.
// Every content credits Renfe and the time of the reading.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { t, lineStateText, passageShort, lineLabel } from './i18n.js';
import { minutesLeft, routeOf, upcomingPassages, cancelledPassages } from './departures.js';
import { rank } from './traffic.js';
import { formatTime, localClock } from './time.js';

const WIDGETS = {
  DEPARTURES: 'departures',
  TRAFFIC: 'traffic',
};

const TTL_SECONDS = {
  departures: 60,
  idle: 300,
  traffic: 180,
  message: 300,
};

const BOARD_COUNT = { min: 1, max: 8, default: 6 };
// Characters a status row holds on one line in a dashboard column: beyond,
// the core cuts the value. A route then drops its last passages.
const ROW_CHARACTERS = 46;
const LABEL_CHARACTERS = 32;
const MAX_LIST_ITEMS = 8;
const MAX_STATUS_ITEMS = 10;
const STATE_COLORS = {
  unknown: WIDGET_COLORS.NEUTRAL,
  normal: WIDGET_COLORS.SUCCESS,
  info: WIDGET_COLORS.INFO,
  disrupted: WIDGET_COLORS.WARNING,
  major: WIDGET_COLORS.DANGER,
};
// A next passage this late colours its row.
const LATE_MINUTES = 5;
// Cancelled trains shown when due within this time.
const CANCELLED_SHOWN_MS = 60 * 60 * 1000;

/**
 * @description Truncate a text to a bound, with an ellipsis.
 * @param {string} value - The text.
 * @param {number} max - The bound.
 * @returns {string} The text.
 * @example
 * clip('Madrid-Chamartín', 12); // -> 'Madrid-Cham…'
 */
function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @description Read a bounded integer setting.
 * @param {unknown} raw - The raw setting.
 * @param {{ min: number, max: number, default: number }} bounds - The bounds.
 * @returns {number} The value.
 */
function readCount(raw, bounds) {
  const value = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) {
    return bounds.default;
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/**
 * @description A widget content made of one message.
 * @param {string} message - The message.
 * @param {number} [ttl] - Its freshness.
 * @returns {object} The content.
 */
function messageContent(message, ttl = TTL_SECONDS.message) {
  return { ttl_seconds: ttl, components: [{ type: 'text', variant: 'body', text: message }] };
}

/**
 * @description The rows of the "departures" widget: one per line and
 * destination, its next passages on one line, soonest route first.
 * @param {object[]} passages - The passages to come, soonest first.
 * @returns {object[][]} The passages of each route.
 */
function routesOf(passages) {
  const byRoute = new Map();
  for (const passage of passages) {
    const route = routeOf(passage);
    byRoute.set(route, [...(byRoute.get(route) ?? []), passage]);
  }
  return [...byRoute.values()];
}

/**
 * @description The times of one route, as on the departure boards, on one
 * line: "3 · 18 · 33 min", "Now · 12 min".
 * @param {object[]} passages - The passages of the route.
 * @param {object} options - `{ language, now, timeZone }`.
 * @returns {string} The value of the row.
 */
function routeValue(passages, options) {
  // A run of waits shares its unit: "10 · 33 min · 11:29".
  const parts = [];
  let run = [];
  const flush = () => {
    if (run.length) {
      parts.push(`${run.join(' · ')} ${t('minutesShort', options.language)}`);
      run = [];
    }
  };
  for (const passage of passages) {
    if (passage.cancelled) {
      flush();
      parts.push(
        t('cancelledShort', options.language, {
          time: formatTime(passage.scheduled, options.timeZone),
        }),
      );
      continue;
    }
    const minutes = minutesLeft(passage, options.now);
    if (minutes > 0 && minutes < 60) {
      run.push(String(minutes));
      continue;
    }
    flush();
    parts.push(passageShort(passage, options));
  }
  flush();
  return clip(parts.join(' · '), 40);
}

/**
 * @description The rows of one station: one compact row per line and
 * destination, soonest first, each row cut to one line.
 * @param {object[]} upcoming - The passages to come, cancelled ones of the
 * next hour included (soonest first).
 * @param {number} count - How many routes (rows).
 * @param {object} options - `{ language, now, timeZone }`.
 * @returns {object[]} The rows.
 */
function boardRows(upcoming, count, options) {
  const nextOf = (route) => route.find((passage) => !passage.cancelled);
  return (
    routesOf(upcoming)
      .filter((route) => nextOf(route))
      // By the next train that runs: a cancelled one does not bring its route up.
      .sort((a, b) => nextOf(a).at - nextOf(b).at)
      .slice(0, count)
      .map((route) => {
        const next = nextOf(route);
        const troubled =
          route.some((passage) => passage.cancelled) ||
          (next.realtime && next.delay >= LATE_MINUTES);
        // Spanish station names are long ("Alcobendas-San Sebastián de los
        // Reyes"): the label leaves room for the times on the same line.
        const label = clip(
          next.destination ? `${next.line} → ${next.destination}` : next.line,
          LABEL_CHARACTERS,
        );
        let shown = route;
        let value = routeValue(shown, options);
        while (shown.length > 1 && label.length + value.length > ROW_CHARACTERS) {
          shown = shown.slice(0, -1);
          value = routeValue(shown, options);
        }
        return { label, value, color: troubled ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS };
      })
  );
}

/**
 * @description The "departures" widget: the station, then one compact row per
 * line and destination, like the departure boards. With several stations
 * (`boards`), still one heading and one list (the content budget of the core
 * allows one status list and two texts): each station opens with a row of its
 * own — its name and the time of its reading —, then its routes.
 * @param {object} options - Options.
 * @param {string} [options.title] - The name of the followed station.
 * @param {object[]} [options.passages] - Its passages.
 * @param {number} [options.readAt] - When they were read (ms).
 * @param {object[]} [options.boards] - Several stations instead:
 * `[{ title, label, passages, readAt }]`, `label` the short name of the station.
 * @param {number} options.count - How many routes (rows) to show per station.
 * @param {string} options.language - The user language.
 * @param {number} options.now - Now (ms).
 * @param {string} [options.timeZone] - IANA timezone.
 * @returns {object} The content.
 */
function buildDeparturesWidget({
  title,
  passages,
  readAt,
  boards = [{ title, passages, readAt }],
  count,
  language,
  now,
  timeZone,
}) {
  const options = { language, now, timeZone };
  // A station takes a row of its own and at least one route.
  const shown = boards.slice(0, Math.floor(MAX_STATUS_ITEMS / 2));
  const several = shown.length > 1;
  const nameOf = (board) => board.label ?? board.title;
  const headingText = several ? [...new Set(shown.map(nameOf))].join(' · ') : shown[0].title;
  const heading = { type: 'text', variant: 'heading', text: clip(headingText, 40) };
  // The oldest reading: the widget never claims fresher data than it shows.
  const oldest = Math.min(...shown.map((board) => board.readAt));
  const updated = t('updatedAt', language, { time: formatTime(oldest, timeZone) });
  const upcomingOf = (board) => upcomingPassages(board.passages, now);
  // The routes, with the trains cancelled in the next hour.
  const rowsOf = (board) =>
    [
      ...upcomingOf(board),
      ...cancelledPassages(board.passages, now).filter(
        (passage) => passage.scheduled - now <= CANCELLED_SHOWN_MS,
      ),
    ].sort((a, b) => a.at - b.at);
  const silent = () => t('noPassage', language);
  if (shown.every((board) => upcomingOf(board).length === 0)) {
    const reason = t('noPassage', language);
    return {
      ttl_seconds: TTL_SECONDS.idle,
      components: [heading, { type: 'text', variant: 'body', text: `${reason}. ${updated}.` }],
    };
  }
  // The routes of each station share what the station rows leave of the list.
  const perStop = several
    ? Math.max(1, Math.min(count, Math.floor((MAX_STATUS_ITEMS - shown.length) / shown.length)))
    : Math.min(count, MAX_STATUS_ITEMS);
  const items = [];
  for (const board of shown) {
    const upcoming = upcomingOf(board);
    if (several) {
      items.push({
        icon: 'map-pin',
        label: clip(nameOf(board), 40),
        value: clip(
          upcoming.length
            ? t('readAt', language, { time: formatTime(board.readAt, timeZone) })
            : silent(),
          40,
        ),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    items.push(...boardRows(rowsOf(board), perStop, options));
  }
  // With several stations, each station row carries its own reading time.
  return {
    ttl_seconds: TTL_SECONDS.departures,
    components: [
      heading,
      { type: 'text', variant: 'caption', text: clip(several ? 'Renfe' : updated, 80) },
      { type: 'status', items },
    ],
  };
}

/**
 * @description "31/10", the day of an instant in the timezone of the instance.
 * @param {number|null} instant - The instant (ms).
 * @param {string} [timeZone] - IANA timezone.
 * @returns {string} The day and month, '' when none.
 */
function shortDate(instant, timeZone) {
  if (!Number.isFinite(instant)) {
    return '';
  }
  return new Intl.DateTimeFormat('fr-FR', { timeZone, day: '2-digit', month: '2-digit' }).format(
    new Date(instant),
  );
}

/**
 * @description A date of a message: "21:30" today, "02/11 04:30" another day.
 * @param {number|null} instant - The instant (ms).
 * @param {number} now - Now (ms).
 * @param {string} [timeZone] - IANA timezone.
 * @returns {string} The date, '' when none.
 */
function dateText(instant, now, timeZone) {
  if (!Number.isFinite(instant)) {
    return '';
  }
  const time = formatTime(instant, timeZone);
  return localClock(instant, timeZone).date === localClock(now, timeZone).date
    ? time
    : `${shortDate(instant, timeZone)} ${time}`;
}

/**
 * @description The period of a message: "02/11 04:30 → 03/11 02:00",
 * "since 15/07 04:00" when its end is far, with its hours of the day.
 * @param {object} message - The message.
 * @param {number} now - Now (ms).
 * @param {string} [timeZone] - IANA timezone.
 * @param {string} language - The language.
 * @returns {string} The period.
 */
function periodText(message, now, timeZone, language) {
  const start = dateText(message.start, now, timeZone);
  const end = dateText(message.end, now, timeZone);
  // An end months away (works "until further notice") says little.
  const farEnd = !Number.isFinite(message.end) || message.end - now > 60 * 24 * 3600 * 1000;
  let period = '';
  if (start && end && !farEnd) {
    period = t('periodFromTo', language, { start, end });
  } else if (start) {
    period = t('periodFrom', language, { start });
  }
  return [period, message.hours].filter(Boolean).join(', ');
}

/**
 * @description The "traffic" widget.
 * @param {object} options - Options.
 * @param {Array<{ line: object, traffic: object }>} options.lines - The lines and their traffic.
 * @param {number|null} options.readAt - When the traffic was read.
 * @param {string} options.language - The user language.
 * @param {number} options.now - Now (ms).
 * @param {string} [options.timeZone] - IANA timezone.
 * @returns {object} The content.
 */
function buildTrafficWidget({ lines, readAt, language, now, timeZone }) {
  const components = [
    { type: 'text', variant: 'heading', text: t('trafficTitle', language) },
    {
      type: 'status',
      items: lines.slice(0, MAX_STATUS_ITEMS).map(({ line, traffic }) => ({
        label: clip(lineLabel(line), 40),
        value: clip(lineStateText(traffic.state, language), 40),
        color: STATE_COLORS[traffic.state] ?? WIDGET_COLORS.NEUTRAL,
      })),
    },
  ];
  // One card per message, even when it covers several of the lines; the
  // messages under way, then the coming ones.
  const grouped = new Map();
  for (const { line, traffic } of lines) {
    // The badge holds 16 characters: "C3", not "Cercanías Madrid C3".
    const label = line.name ?? lineLabel(line);
    const listed = [
      ...traffic.messages.map((message) => ({ message, coming: false })),
      ...(traffic.upcoming ?? []).map((message) => ({ message, coming: true })),
    ];
    for (const { message, coming } of listed) {
      const entry = grouped.get(message.id) ?? { message, coming, names: [] };
      if (!entry.names.includes(label)) {
        entry.names.push(label);
      }
      grouped.set(message.id, entry);
    }
  }
  const items = [...grouped.values()].sort(
    (a, b) =>
      Number(a.coming) - Number(b.coming) ||
      rank(b.message.state) - rank(a.message.state) ||
      (a.coming
        ? (a.message.start ?? 0) - (b.message.start ?? 0)
        : (b.message.start ?? 0) - (a.message.start ?? 0)),
  );
  if (items.length > 0) {
    components.push({
      type: 'card-list',
      display: 'list',
      items: items.slice(0, MAX_LIST_ITEMS).map(({ message, coming, names }) => {
        const item = {
          title: clip(message.title || names.join(', '), 60),
          subtitle: clip(
            [
              coming ? t('upcomingState', language) : t(`kind_${message.state}`, language),
              periodText(message, now, timeZone, language),
            ]
              .filter(Boolean)
              .join(' · '),
            60,
          ),
          badge: {
            text: clip(names.join(' · '), 16),
            color: coming
              ? WIDGET_COLORS.NEUTRAL
              : (STATE_COLORS[message.state] ?? WIDGET_COLORS.NEUTRAL),
          },
        };
        if (message.text) {
          item.description = clip(message.text, 2000);
        }
        if (/^https:\/\//.test(message.url) && message.url.length <= 2048) {
          item.links = [{ url: message.url, label: clip(t('moreInfo', language), 24) }];
        }
        return item;
      }),
    });
  }
  // Two texts at most: without a message, the body carries the update time.
  const updated = readAt ? t('updatedAt', language, { time: formatTime(readAt, timeZone) }) : '';
  if (items.length === 0) {
    components.push({
      type: 'text',
      variant: 'body',
      text: [t('noMessage', language), updated && `${updated}.`].filter(Boolean).join(' '),
    });
  } else if (updated) {
    components.push({ type: 'text', variant: 'caption', text: updated });
  }
  return { ttl_seconds: TTL_SECONDS.traffic, components };
}

export {
  WIDGETS,
  TTL_SECONDS,
  BOARD_COUNT,
  STATE_COLORS,
  clip,
  messageContent,
  readCount,
  routeValue,
  shortDate,
  dateText,
  periodText,
  buildDeparturesWidget,
  buildTrafficWidget,
};
