// -----------------------------------------------------------------------------
// The traffic of the Cercanías lines, read every 5 minutes from the GTFS-RT
// service alerts of Renfe (works, modified frequencies, incidents, road
// replacement services):
//   - each alert names its routes (`informed_entity.route_id`: one per
//     direction, gathered into their line, network.js) or a station (lifts out
//     of order, closed stations: those are left out here, they are no state of
//     a line), its periods of validity (Unix times, often without an end) and
//     a Spanish text, often opened by a tag ("#MadC5 Por obras…") that is
//     dropped. Without a header, the title is its first sentence;
//   - its weight comes from its effect when Renfe sets one (NO_SERVICE ->
//     major; reduced service, delays, detour, modified service -> disrupted;
//     the others -> info), else from its words, accents aside
//     ("interrumpida", "sin servicio", "por carretera", "por autobús" ->
//     major; "retrasos", "huelga", "incidencia", "frecuencias modificadas",
//     "obras" -> disrupted).
// States of a line, from the mildest: `unknown` (nothing read yet), `normal`,
// `info` (a message under way, normal service), `disrupted`, `major`: the
// heaviest message under way. The texts stay in Spanish.
// The long distance trains have no alert feed: their delays and
// cancellations are those of the trains.
// -----------------------------------------------------------------------------

import { MINUTE_MS } from './time.js';
import { fold } from './network.js';

const STATES = ['unknown', 'normal', 'info', 'disrupted', 'major'];
const SERIOUS = ['disrupted', 'major'];
// A message starting this soon is shown as coming.
const UPCOMING_MS = 3 * 24 * 60 * MINUTE_MS;
const TEXT_MAX = 2000;
const TITLE_MAX = 140;
// A first sentence shorter than this is a heading ("Línea C1.").
const SHORT_TITLE = 25;
// GTFS-RT effects, by name (the JSON feed) or number (the protobuf one).
const EFFECT_STATES = {
  NO_SERVICE: 'major',
  REDUCED_SERVICE: 'disrupted',
  SIGNIFICANT_DELAYS: 'disrupted',
  DETOUR: 'disrupted',
  MODIFIED_SERVICE: 'disrupted',
  ADDITIONAL_SERVICE: 'info',
  OTHER_EFFECT: null,
  UNKNOWN_EFFECT: null,
  STOP_MOVED: 'disrupted',
  NO_EFFECT: 'info',
  ACCESSIBILITY_ISSUE: 'info',
};
// Compared to the folded text: lower case, no accent, words.
const MAJOR_WORDS =
  /\b(interrumpid[oa]s?|interrupcion|suspendid[oa]s?|suspension|sin servicio|sin circulacion|no (circula|circulan|hay servicio|presta(n)? servicio)|cortad[oa]|corte de (la )?(via|linea|circulacion)|por carretera|por autobus(es)?|transporte alternativo)\b/;
const DISRUPTED_WORDS =
  /\b(huelga|servicios? minimos?|retrasos?|demoras?|incidencias?|averias?|afectad[oa]s?|alteracion(es)?|alterad[oa]s?|frecuencias? (de paso )?modificad[oa]s?|modificacion(es)?|desvio|desviad[oa]s?|obras|limitacion(es)?|reduccion|reducid[oa]s?|transbordo|via unica|no (para|efectua|efectuan) parada|sin parada)\b/;
// A message about one train, not the line.
const ONE_TRAIN_WORDS = /\btren con salida\b/;
// Lifts, escalators, entrances, toilets: an information, never a disruption
// of the trains.
const ACCESS_WORDS =
  /\b(ascensor(es)?|escaleras?|plataformas? elevadoras?|accesib\w*|pmr|movilidad reducida|aseos|acceso (principal )?(a la|de la) estacion|vestibulo)\b/;
// The tag opening some texts: "#MadC5", "#RodaliesR2".
const LEADING_TAGS = /^(#[\p{L}\p{N}_]+\s*)+/u;
// The entities a text may hold.
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  laquo: '«',
  raquo: '»',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  hellip: '…',
};

/**
 * @description Decode the HTML entities of a text.
 * @param {string} value - The text.
 * @returns {string} The text.
 */
const decodeEntities = (value) =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });

/**
 * @description A plain text: no tags, one line per paragraph or list item,
 * blank lines and internal references dropped.
 * @param {unknown} value - The text (HTML or plain).
 * @param {number} [max] - Its longest length.
 * @returns {string} The text.
 */
function plainText(value, max = TEXT_MAX) {
  // The Basque and Spanish texts of Bilbao and San Sebastián: "… // …",
  // the Spanish one last.
  const parts = String(value ?? '').split(/\s+\/\/\s+/);
  const text = parts[parts.length - 1]
    .replace(/\r/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .map((line) => line.replace(LEADING_TAGS, '').trim())
    .filter((line) => line && line !== '-')
    .join('\n')
    .slice(0, max);
}

/**
 * @description A short title.
 * @param {string} title - The title of the message.
 * @param {string} text - Its text.
 * @returns {string} The title, or the first sentence of the text, at most
 * TITLE_MAX characters.
 */
function titleOf(title, text) {
  if (title) {
    return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
  }
  // "Línea C1. Tren con salida…", "AMETZOLA. Ascensor…", "ATENCIÓN Línea
  // C3:": a heading alone says too little, the next sentence joins it.
  let rest = text.replace(/\s*\n\s*/g, ' ').trim();
  let sentence = '';
  while (rest && sentence.length < SHORT_TITLE) {
    const match = /^(.+?[.!?:])(\s|$)/.exec(rest);
    const piece = match ? match[1] : rest;
    sentence = sentence ? `${sentence} ${piece}` : piece;
    rest = rest.slice(piece.length).trim();
  }
  sentence = sentence.replace(/\s*:$/, '');
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 1)}…` : sentence;
}

/**
 * @description The first link of an HTML description (the map of a diversion).
 * @param {unknown} html - The description.
 * @returns {string} The URL, '' when none.
 */
const firstLink = (html) => decodeEntities(/href="([^"]+)"/i.exec(String(html ?? ''))?.[1] ?? '');

/**
 * @description The document of a message, when on https.
 * @param {unknown} value - The URL.
 * @returns {string} The URL, '' when none.
 */
function linkOf(value) {
  const url = String(value ?? '').trim();
  if (!/^https:\/\/\S+$/i.test(url.replace(/ /g, '%20')) || url.length > 2048) {
    return '';
  }
  return url.replace(/ /g, '%20');
}

/**
 * @description Whether the header of an alert reads as a title, not a code.
 * @param {string} header - The header text.
 * @returns {boolean} True for words, false for "TR/L17/Dev/ TRL17Dev- …".
 */
const readableHeader = (header) =>
  /[a-zàâçéèêëîïôûùüÿœ]{3}/.test(header) && !/[A-Za-z0-9]+\/[A-Za-z0-9]+\//.test(header);

/**
 * @description The weight of an alert.
 * @param {object} alert - The alert (effect, severity).
 * @param {string} text - Its text.
 * @returns {string} `info`, `disrupted` or `major`.
 */
function alertState(alert, text) {
  if (alert.severity === 'SEVERE') {
    return 'major';
  }
  if (EFFECT_STATES[alert.effect]) {
    return EFFECT_STATES[alert.effect];
  }
  const words = fold(text);
  if (ACCESS_WORDS.test(words)) {
    return 'info';
  }
  // "Tren con salida prevista a las 22:30h … hoy no circula": one train.
  if (MAJOR_WORDS.test(words) && !ONE_TRAIN_WORDS.test(words)) {
    return 'major';
  }
  return DISRUPTED_WORDS.test(words) || MAJOR_WORDS.test(words) ? 'disrupted' : 'info';
}

/**
 * @description What is kept of an alert.
 * @param {object} alert - An alert of the feed (readAlerts()).
 * @param {Function} [lineOfRoute] - `(route id) => line`, to gather the routes
 * of the two directions into their line.
 * @returns {object} `{ id, lineIds, stationIds, state, title, text, url,
 * periods, hours }`, periods `[{ start, end }]` in ms (null when open).
 */
function messageOf(alert, lineOfRoute = () => null) {
  const header = plainText(alert.header, TITLE_MAX * 2);
  const description = plainText(alert.description);
  const title = titleOf(readableHeader(header) ? header : '', description);
  const text = description || (readableHeader(header) ? header : '');
  const lineIds = [
    ...new Set(alert.routeIds.map((routeId) => lineOfRoute(routeId)?.id).filter(Boolean)),
  ];
  return {
    id: String(alert.id),
    lineIds,
    stationIds: [...alert.stopIds],
    state: alertState(alert, `${header} ${description}`),
    title,
    text,
    url: linkOf(alert.url) || linkOf(firstLink(alert.description)),
    periods: alert.periods.map((period) => ({
      start: period.start ? period.start * 1000 : null,
      end: period.end ? period.end * 1000 : null,
    })),
    hours: '',
  };
}

/**
 * @description Read the traffic.
 * @param {object} feed - readAlerts() of the alerts.
 * @param {object} [options] - `{ lineOfRoute }`.
 * @returns {{ messages: object[] }} The messages about a line.
 */
function parseTraffic(feed, { lineOfRoute } = {}) {
  return {
    messages: (feed?.alerts ?? [])
      .map((alert) => messageOf(alert, lineOfRoute))
      .filter((message) => message.lineIds.length > 0 && (message.text || message.title)),
  };
}

/**
 * @description The rank of a state, for comparisons.
 * @param {string} state - A state.
 * @returns {number} Its position in STATES.
 */
const rank = (state) => STATES.indexOf(state);

/**
 * @description A message as it stands at an instant: under way (the period
 * holding now), coming (its next period) or over.
 * @param {object} message - The message.
 * @param {number} now - Now (ms).
 * @returns {object|null} The message with `start`, `end` and `coming`, null when over.
 */
function messageAt(message, now) {
  const periods = message.periods.length ? message.periods : [{ start: null, end: null }];
  const current = periods.find(
    (period) => (period.start ?? -Infinity) <= now && (period.end ?? Infinity) > now,
  );
  if (current) {
    return { ...message, start: current.start, end: current.end, coming: false };
  }
  const next = periods
    .filter((period) => period.start !== null && period.start > now)
    .sort((a, b) => a.start - b.start)[0];
  return next ? { ...message, start: next.start, end: next.end, coming: true } : null;
}

/**
 * @description The traffic of one line.
 * @param {object|null} traffic - parseTraffic().
 * @param {string} lineId - The route id.
 * @param {number} now - Now (ms).
 * @returns {{ state: string, since: number|null, messages: object[], upcoming: object[] }}
 * Its state, the messages under way (heaviest, then latest start first) and
 * the ones coming in the next three days (soonest first).
 */
function lineTraffic(traffic, lineId, now) {
  if (!traffic) {
    return { state: 'unknown', since: null, messages: [], upcoming: [] };
  }
  const own = traffic.messages
    .filter((message) => message.lineIds.includes(lineId))
    .map((message) => messageAt(message, now))
    .filter(Boolean);
  const messages = own
    .filter((message) => !message.coming)
    .sort((a, b) => rank(b.state) - rank(a.state) || (b.start ?? 0) - (a.start ?? 0));
  const upcoming = own
    .filter((message) => message.coming && message.start - now <= UPCOMING_MS)
    .sort((a, b) => a.start - b.start);
  const state = messages[0]?.state ?? 'normal';
  return {
    state,
    since: SERIOUS.includes(state) ? (messages[0].start ?? null) : null,
    messages,
    upcoming,
  };
}

/**
 * @description The messages of a line about a disruption under way.
 * @param {{ messages: object[] }} line - lineTraffic().
 * @returns {object[]} The messages.
 */
const seriousMessages = (line) => line.messages.filter((m) => SERIOUS.includes(m.state));

export {
  STATES,
  SERIOUS,
  UPCOMING_MS,
  decodeEntities,
  plainText,
  titleOf,
  firstLink,
  linkOf,
  readableHeader,
  alertState,
  messageOf,
  parseTraffic,
  rank,
  messageAt,
  lineTraffic,
  seriousMessages,
};
