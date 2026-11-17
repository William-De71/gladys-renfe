// -----------------------------------------------------------------------------
// Texts of the integration, in English, French, German and Spanish (English
// fallback).
//
// The manifest carries its own labels; these are the texts the code writes at
// runtime: device and feature names, line states, widget contents, scene
// summaries, messages of the Configuration screen. Vocabulary of the Gladys
// interface (appareil / Gerät / dispositivo, scène / Szene / escena) and of
// the railway (gare / Bahnhof / estación, voie / Gleis / vía, retard /
// Verspätung / retraso). The names of stations and lines, the destinations
// and the traffic messages stay as Renfe writes them, in Spanish.
// -----------------------------------------------------------------------------

import { minutesLeft, trainLabel } from './departures.js';
import { formatTime } from './time.js';

const LANGUAGES = ['en', 'fr', 'de', 'es'];
// The brand of the operator, in device names and summaries.
const BRAND = 'Renfe';

const TEXTS = {
  // devices
  stationDeviceName: {
    en: 'Renfe {station}',
    fr: 'Renfe {station}',
    de: 'Renfe {station}',
    es: 'Renfe {station}',
  },
  featureNext: {
    en: 'Next train',
    fr: 'Prochain train',
    de: 'Nächster Zug',
    es: 'Próximo tren',
  },
  featureWait: {
    en: 'Wait',
    fr: 'Attente',
    de: 'Wartezeit',
    es: 'Espera',
  },
  featureFollowing: {
    en: 'Wait for the following one',
    fr: 'Attente du suivant',
    de: 'Wartezeit des folgenden',
    es: 'Espera del siguiente',
  },
  featureDelay: {
    en: 'Delay of the next train',
    fr: 'Retard du prochain train',
    de: 'Verspätung des nächsten Zuges',
    es: 'Retraso del próximo tren',
  },
  featureStatus: {
    en: 'Traffic',
    fr: 'Trafic',
    de: 'Verkehrslage',
    es: 'Estado del servicio',
  },
  featureMessages: {
    en: 'Traffic messages under way',
    fr: 'Infos trafic en cours',
    de: 'Aktuelle Verkehrsmeldungen',
    es: 'Avisos en curso',
  },

  // trains
  noPassage: {
    en: 'No train announced',
    fr: 'Aucun train annoncé',
    de: 'Kein Zug angekündigt',
    es: 'Ningún tren anunciado',
  },
  minutesValue: {
    en: '{n} min',
    fr: '{n} min',
    de: '{n} Min.',
    es: '{n} min',
  },
  approaching: {
    en: 'Now',
    fr: 'Maintenant',
    de: 'Jetzt',
    es: 'Ahora',
  },
  inMinutes: {
    en: 'in {n} min',
    fr: 'dans {n} min',
    de: 'in {n} Min.',
    es: 'dentro de {n} min',
  },
  atTime: {
    en: 'at {time}',
    fr: 'à {time}',
    de: 'um {time}',
    es: 'a las {time}',
  },
  scheduledMark: {
    en: '(timetable)',
    fr: '(théorique)',
    de: '(Fahrplan)',
    es: '(teórico)',
  },
  lateMark: {
    en: '(+{n} min late)',
    fr: '(+{n} min de retard)',
    de: '(+{n} Min. Verspätung)',
    es: '(+{n} min de retraso)',
  },
  trackMark: {
    en: 'track {track}',
    fr: 'voie {track}',
    de: 'Gleis {track}',
    es: 'vía {track}',
  },
  arrivalMark: {
    en: 'arr. {time}',
    fr: 'arr. {time}',
    de: 'an {time}',
    es: 'llegada {time}',
  },
  cancelledShort: {
    en: 'cancelled {time}',
    fr: 'supprimé {time}',
    de: 'fällt aus {time}',
    es: 'suprimido {time}',
  },

  // line states
  state_unknown: {
    en: 'No information',
    fr: 'Pas d’information',
    de: 'Keine Information',
    es: 'Sin información',
  },
  state_normal: {
    en: 'Normal traffic',
    fr: 'Trafic normal',
    de: 'Normaler Betrieb',
    es: 'Servicio normal',
  },
  state_info: {
    en: 'Traffic information',
    fr: 'Info trafic',
    de: 'Verkehrsinformation',
    es: 'Aviso',
  },
  state_disrupted: {
    en: 'Disrupted traffic',
    fr: 'Trafic perturbé',
    de: 'Gestörter Betrieb',
    es: 'Servicio alterado',
  },
  state_major: {
    en: 'Heavily disrupted traffic',
    fr: 'Trafic très perturbé',
    de: 'Stark gestörter Betrieb',
    es: 'Servicio muy alterado',
  },
  stateWithTitle: {
    en: '{state}: {title}',
    fr: '{state} : {title}',
    de: '{state}: {title}',
    es: '{state}: {title}',
  },
  kind_info: {
    en: 'Information',
    fr: 'Information',
    de: 'Information',
    es: 'Información',
  },
  kind_disrupted: {
    en: 'Disruption',
    fr: 'Perturbation',
    de: 'Störung',
    es: 'Incidencia',
  },
  kind_major: {
    en: 'Heavy disruption',
    fr: 'Forte perturbation',
    de: 'Starke Störung',
    es: 'Incidencia grave',
  },
  upcomingState: {
    en: 'Coming',
    fr: 'À venir',
    de: 'Demnächst',
    es: 'Próximamente',
  },

  // scene summaries
  summarySoon: {
    en: '{train} to {destination} leaves {station} in {minutes} min ({time}).',
    fr: '{train} vers {destination} part de {station} dans {minutes} min ({time}).',
    de: '{train} nach {destination} fährt in {station} in {minutes} Min. ab ({time}).',
    es: '{train} con destino {destination} sale de {station} dentro de {minutes} min ({time}).',
  },
  summarySoonLate: {
    en: '{train} to {destination} leaves {station} in {minutes} min ({time}, {delay} min late).',
    fr: '{train} vers {destination} part de {station} dans {minutes} min ({time}, {delay} min de retard).',
    de: '{train} nach {destination} fährt in {station} in {minutes} Min. ab ({time}, {delay} Min. Verspätung).',
    es: '{train} con destino {destination} sale de {station} dentro de {minutes} min ({time}, {delay} min de retraso).',
  },
  summaryDelayed: {
    en: 'The {time} {train} to {destination} from {station} is {delay} min late: it leaves at {expected}.',
    fr: 'Le {train} de {time} vers {destination} au départ de {station} a {delay} min de retard : départ à {expected}.',
    de: 'Der {train} um {time} nach {destination} ab {station} hat {delay} Min. Verspätung: Abfahrt um {expected}.',
    es: 'El {train} de las {time} con destino {destination} desde {station} lleva {delay} min de retraso: sale a las {expected}.',
  },
  summaryCancelled: {
    en: 'The {time} {train} to {destination} from {station} is cancelled.',
    fr: 'Le {train} de {time} vers {destination} au départ de {station} est supprimé.',
    de: 'Der {train} um {time} nach {destination} ab {station} fällt aus.',
    es: 'El {train} de las {time} con destino {destination} desde {station} está suprimido.',
  },
  summaryDisrupted: {
    en: '{line}: {state}.',
    fr: '{line} : {state}.',
    de: '{line}: {state}.',
    es: '{line}: {state}.',
  },
  summaryDisruptedTitle: {
    en: '{line}: {state} ({title})',
    fr: '{line} : {state} ({title})',
    de: '{line}: {state} ({title})',
    es: '{line}: {state} ({title})',
  },
  summaryRestored: {
    en: '{line}: no disruption any more ({state}).',
    fr: '{line} : fin de perturbation ({state}).',
    de: '{line}: keine Störung mehr ({state}).',
    es: '{line}: fin de la incidencia ({state}).',
  },
  summaryMessage: {
    en: '{line}, information: {title}',
    fr: '{line}, info trafic : {title}',
    de: '{line}, Information: {title}',
    es: '{line}, aviso: {title}',
  },
  summaryMessageIncident: {
    en: '{line}, disruption: {title}',
    fr: '{line}, perturbation : {title}',
    de: '{line}, Störung: {title}',
    es: '{line}, incidencia: {title}',
  },
  summaryLineState: {
    en: '{line}: {state} ({title})',
    fr: '{line} : {state} ({title})',
    de: '{line}: {state} ({title})',
    es: '{line}: {state} ({title})',
  },
  summaryLineStateOnly: {
    en: '{line}: {state}.',
    fr: '{line} : {state}.',
    de: '{line}: {state}.',
    es: '{line}: {state}.',
  },
  outputNext: {
    en: 'Next train from {station}: {train} to {destination} {when}.',
    fr: 'Prochain train au départ de {station} : {train} vers {destination} {when}.',
    de: 'Nächster Zug ab {station}: {train} nach {destination} {when}.',
    es: 'Próximo tren desde {station}: {train} con destino {destination} {when}.',
  },
  outputFollowing: {
    en: 'The following one {when}.',
    fr: 'Le suivant {when}.',
    de: 'Der folgende {when}.',
    es: 'El siguiente {when}.',
  },
  outputNone: {
    en: 'No train announced from {station}.',
    fr: 'Aucun train annoncé au départ de {station}.',
    de: 'Kein Zug ab {station} angekündigt.',
    es: 'Ningún tren anunciado desde {station}.',
  },

  // widgets
  readAt: {
    en: 'read at {time}',
    fr: 'lu à {time}',
    de: 'gelesen um {time}',
    es: 'leído a las {time}',
  },
  updatedAt: {
    en: 'Renfe · updated at {time}',
    fr: 'Renfe · mis à jour à {time}',
    de: 'Renfe · aktualisiert um {time}',
    es: 'Renfe · actualizado a las {time}',
  },
  minutesShort: {
    en: 'min',
    fr: 'min',
    de: 'Min.',
    es: 'min',
  },
  moreInfo: {
    en: 'More information',
    fr: 'En savoir plus',
    de: 'Mehr erfahren',
    es: 'Más información',
  },
  trafficTitle: {
    en: 'Renfe traffic',
    fr: 'Trafic Renfe',
    de: 'Renfe Verkehrslage',
    es: 'Estado del servicio Renfe',
  },
  periodFromTo: {
    en: '{start} → {end}',
    fr: '{start} → {end}',
    de: '{start} → {end}',
    es: '{start} → {end}',
  },
  periodFrom: {
    en: 'from {start}',
    fr: 'depuis {start}',
    de: 'seit {start}',
    es: 'desde {start}',
  },
  noMessage: {
    en: 'No traffic message for these lines.',
    fr: 'Aucune info trafic pour ces lignes.',
    de: 'Keine Verkehrsmeldung für diese Linien.',
    es: 'Ningún aviso para estas líneas.',
  },
  widgetNoStation: {
    en: 'No station is followed: add one on the Configuration screen of the integration, or type one in the widget settings.',
    fr: 'Aucune gare n’est suivie : ajoutez-en une dans l’écran Configuration de l’intégration, ou saisissez-en une dans les réglages du widget.',
    de: 'Kein Bahnhof wird verfolgt: Füge einen im Konfigurationsbildschirm der Integration hinzu oder gib einen in den Widget-Einstellungen ein.',
    es: 'No se sigue ninguna estación: añade una en la pantalla Configuración de la integración, o escribe una en los ajustes del widget.',
  },
  widgetNoLine: {
    en: 'No Cercanías line is followed: add one on the Configuration screen of the integration, or type one in the widget settings ("C3 Madrid").',
    fr: 'Aucune ligne de Cercanías n’est suivie : ajoutez-en une dans l’écran Configuration de l’intégration, ou saisissez-en une dans les réglages du widget (« C3 Madrid »).',
    de: 'Keine Cercanías-Linie wird verfolgt: Füge eine im Konfigurationsbildschirm der Integration hinzu oder gib eine in den Widget-Einstellungen ein („C3 Madrid“).',
    es: 'No se sigue ninguna línea de Cercanías: añade una en la pantalla Configuración de la integración, o escribe una en los ajustes del widget («C3 Madrid»).',
  },

  // configuration and status
  statusUnreachable: {
    en: 'The open data of Renfe do not answer ({detail}). Next try in {minutes} min.',
    fr: 'L’open data de Renfe ne répond pas ({detail}). Nouvel essai dans {minutes} min.',
    de: 'Die Open Data von Renfe antworten nicht ({detail}). Neuer Versuch in {minutes} Min.',
    es: 'Los datos abiertos de Renfe no responden ({detail}). Nuevo intento dentro de {minutes} min.',
  },
  statusConnected: {
    en: 'Connected to Renfe: {stations} station(s), {lines} line(s), real time read every {interval} s.',
    fr: 'Connecté à Renfe : {stations} gare(s), {lines} ligne(s), temps réel lu toutes les {interval} s.',
    de: 'Mit Renfe verbunden: {stations} Bahnhof/Bahnhöfe, {lines} Linie(n), Echtzeit alle {interval} s gelesen.',
    es: 'Conectado a Renfe: {stations} estación(es), {lines} línea(s), tiempo real leído cada {interval} s.',
  },
  statusNotFound: {
    en: 'Unknown or ambiguous: {names}.',
    fr: 'Inconnu ou ambigu : {names}.',
    de: 'Unbekannt oder mehrdeutig: {names}.',
    es: 'Desconocido o ambiguo: {names}.',
  },
  statusNothing: {
    en: 'Connected to Renfe. Add a station or a line on the Configuration screen.',
    fr: 'Connecté à Renfe. Ajoutez une gare ou une ligne dans l’écran Configuration.',
    de: 'Mit Renfe verbunden. Füge im Konfigurationsbildschirm einen Bahnhof oder eine Linie hinzu.',
    es: 'Conectado a Renfe. Añade una estación o una línea en la pantalla Configuración.',
  },
  testNetworkOk: {
    en: 'Renfe open data reached: {lines} lines, {stations} stations',
    fr: 'Open data Renfe joint : {lines} lignes, {stations} gares',
    de: 'Renfe Open Data erreicht: {lines} Linien, {stations} Bahnhöfe',
    es: 'Datos abiertos de Renfe alcanzados: {lines} líneas, {stations} estaciones',
  },
  testStation: {
    en: '{station}: {count} train(s), next {next}',
    fr: '{station} : {count} train(s), prochain {next}',
    de: '{station}: {count} Zug/Züge, nächster {next}',
    es: '{station}: {count} tren(es), próximo {next}',
  },
  testStationError: {
    en: '{station}: {error}',
    fr: '{station} : {error}',
    de: '{station}: {error}',
    es: '{station}: {error}',
  },
  testLine: {
    en: '{line}: {state}',
    fr: '{line} : {state}',
    de: '{line}: {state}',
    es: '{line}: {state}',
  },
  testTrafficError: {
    en: 'Traffic: {error}',
    fr: 'Trafic : {error}',
    de: 'Verkehrslage: {error}',
    es: 'Estado del servicio: {error}',
  },
  unknownEntry: {
    en: 'unknown or ambiguous: {name}',
    fr: 'inconnu ou ambigu : {name}',
    de: 'unbekannt oder mehrdeutig: {name}',
    es: 'desconocido o ambiguo: {name}',
  },
  errorUnreachable: {
    en: 'the open data of Renfe do not answer',
    fr: 'l’open data de Renfe ne répond pas',
    de: 'die Open Data von Renfe antworten nicht',
    es: 'los datos abiertos de Renfe no responden',
  },
  errorBusy: {
    en: 'the open data server of Renfe is busy, try again in a moment',
    fr: 'le serveur open data de Renfe est occupé, réessayez dans un instant',
    de: 'der Open-Data-Server von Renfe ist ausgelastet, versuche es gleich noch einmal',
    es: 'el servidor de datos abiertos de Renfe está ocupado, inténtalo de nuevo en un momento',
  },
  searchTooShort: {
    en: 'Type at least two letters of the station name.',
    fr: 'Saisissez au moins deux lettres du nom de la gare.',
    de: 'Gib mindestens zwei Buchstaben des Bahnhofsnamens ein.',
    es: 'Escribe al menos dos letras del nombre de la estación.',
  },
  searchNone: {
    en: 'No station matches "{query}".',
    fr: 'Aucune gare ne correspond à « {query} ».',
    de: 'Kein Bahnhof passt zu „{query}“.',
    es: 'Ninguna estación coincide con «{query}».',
  },
  searchFound: {
    en: 'Type the name as written, or the code in brackets; the lines after the arrow ("C3 Madrid": a Cercanías line and its núcleo):\n{list}',
    fr: 'Saisissez le nom tel qu’écrit, ou le code entre crochets ; les lignes après la flèche (« C3 Madrid » : une ligne de Cercanías et son núcleo) :\n{list}',
    de: 'Gib den Namen so ein, wie er geschrieben ist, oder den Code in Klammern; die Linien nach dem Pfeil („C3 Madrid“: eine Cercanías-Linie und ihr Núcleo):\n{list}',
    es: 'Escribe el nombre tal como aparece, o el código entre corchetes; las líneas tras la flecha («C3 Madrid»: una línea de Cercanías y su núcleo):\n{list}',
  },

  // stations added with the configuration buttons
  stationAdded: {
    en: 'Station added: {name}. {count} station(s) followed. Its device is offered in the Discover tab.',
    fr: 'Gare ajoutée : {name}. {count} gare(s) suivie(s). Son appareil est proposé dans l’onglet Découvrir.',
    de: 'Bahnhof hinzugefügt: {name}. {count} Bahnhof/Bahnhöfe verfolgt. Sein Gerät wird im Tab Entdecken angeboten.',
    es: 'Estación añadida: {name}. {count} estación(es) seguida(s). Su dispositivo se ofrece en la pestaña Descubrir.',
  },
  stationAlreadyFollowed: {
    en: '{name} is already followed.',
    fr: '{name} est déjà suivie.',
    de: '{name} wird bereits verfolgt.',
    es: '{name} ya se sigue.',
  },
  stationsFull: {
    en: 'Already {max} stations added: remove one first.',
    fr: 'Déjà {max} gares ajoutées : retirez-en une d’abord.',
    de: 'Bereits {max} Bahnhöfe hinzugefügt: entferne zuerst einen.',
    es: 'Ya hay {max} estaciones añadidas: quita una primero.',
  },
  stationRemoved: {
    en: 'Station removed: {name}. Delete its device in Gladys if you no longer want it.',
    fr: 'Gare retirée : {name}. Supprimez son appareil dans Gladys si vous n’en voulez plus.',
    de: 'Bahnhof entfernt: {name}. Lösche sein Gerät in Gladys, wenn du es nicht mehr brauchst.',
    es: 'Estación quitada: {name}. Borra su dispositivo en Gladys si ya no lo quieres.',
  },
  stationRemoveUnknown: {
    en: 'No added station matches "{query}": type its number given by "List the stations".',
    fr: 'Aucune gare ajoutée ne correspond à « {query} » : saisissez son numéro donné par « Lister les gares ».',
    de: 'Kein hinzugefügter Bahnhof passt zu „{query}“: gib seine Nummer aus „Bahnhöfe auflisten“ ein.',
    es: 'Ninguna estación añadida coincide con «{query}»: escribe su número dado por «Listar las estaciones».',
  },
  stationRemoveAmbiguous: {
    en: 'Several added stations match "{query}": type the number given by "List the stations".',
    fr: 'Plusieurs gares ajoutées correspondent à « {query} » : saisissez le numéro donné par « Lister les gares ».',
    de: 'Mehrere hinzugefügte Bahnhöfe passen zu „{query}“: gib die Nummer aus „Bahnhöfe auflisten“ ein.',
    es: 'Varias estaciones añadidas coinciden con «{query}»: escribe el número dado por «Listar las estaciones».',
  },
  stationInForm: {
    en: '{name} is station {slot} of the form: empty its field, then save the configuration.',
    fr: '{name} est la gare {slot} du formulaire : videz son champ, puis enregistrez la configuration.',
    de: '{name} ist Bahnhof {slot} des Formulars: leere sein Feld und speichere dann die Konfiguration.',
    es: '{name} es la estación {slot} del formulario: vacía su campo y guarda la configuración.',
  },
  stationsNone: {
    en: 'No station followed yet: fill in a station of the form or press "Add a station".',
    fr: 'Aucune gare suivie pour l’instant : remplissez une gare du formulaire ou appuyez sur « Ajouter une gare ».',
    de: 'Noch kein Bahnhof verfolgt: fülle einen Bahnhof im Formular aus oder drücke „Bahnhof hinzufügen“.',
    es: 'Aún no se sigue ninguna estación: rellena una estación del formulario o pulsa «Añadir una estación».',
  },
  stationsList: {
    en: '{count} station(s) followed:\n{list}',
    fr: '{count} gare(s) suivie(s) :\n{list}',
    de: '{count} Bahnhof/Bahnhöfe verfolgt:\n{list}',
    es: '{count} estación(es) seguida(s):\n{list}',
  },
  stationFromForm: {
    en: 'form, station {slot}',
    fr: 'formulaire, gare {slot}',
    de: 'Formular, Bahnhof {slot}',
    es: 'formulario, estación {slot}',
  },
  stationUnknownMark: {
    en: 'unknown or ambiguous',
    fr: 'inconnu ou ambigu',
    de: 'unbekannt oder mehrdeutig',
    es: 'desconocido o ambiguo',
  },
  diagnosticDone: {
    en: 'Diagnostic written to the Logs tab ({count} line(s) starting with "Renfe diagnostic").',
    fr: 'Diagnostic écrit dans l’onglet Journaux ({count} ligne(s) commençant par « Renfe diagnostic »).',
    de: 'Diagnose in den Tab Protokolle geschrieben ({count} Zeile(n), beginnend mit „Renfe diagnostic“).',
    es: 'Diagnóstico escrito en la pestaña Registros ({count} línea(s) que empiezan por «Renfe diagnostic»).',
  },
};

/**
 * @description Whether a value is a supported language.
 * @param {unknown} value - The value.
 * @returns {boolean} True for en, fr, de, es.
 */
function isLanguage(value) {
  return LANGUAGES.includes(value);
}

/**
 * @description A text in a language, its placeholders filled.
 * @param {string} key - A TEXTS key.
 * @param {string} language - The language (English when unknown).
 * @param {object} [values] - The placeholder values.
 * @returns {string} The text.
 * @example
 * t('inMinutes', 'fr', { n: 3 }); // -> 'dans 3 min'
 */
function t(key, language, values = {}) {
  const entry = TEXTS[key];
  if (!entry) {
    return key;
  }
  const template = entry[isLanguage(language) ? language : 'en'] ?? entry.en;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    values[name] === undefined || values[name] === null ? '' : String(values[name]),
  );
}

/**
 * @description A text in the four languages.
 * @param {string} key - A TEXTS key.
 * @param {object|Function} [values] - The values, or `(language) => values`.
 * @returns {object} `{ en, fr, de, es }`.
 */
function all(key, values = {}) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      t(key, language, typeof values === 'function' ? values(language) : values),
    ]),
  );
}

/**
 * @description The label of a line state.
 * @param {string} state - A state name (traffic.js).
 * @param {string} language - The language.
 * @returns {string} The label.
 */
const lineStateText = (state, language) =>
  t(TEXTS[`state_${state}`] ? `state_${state}` : 'state_unknown', language);

/**
 * @description How a line reads in a sentence or a list: "AVE", "Cercanías
 * Madrid C3", "Rodalies R2N" (proper names, the same in every language).
 * @param {{ name: string, network: string, nucleo: string, nucleoName: string }} line - The line.
 * @returns {string} The label.
 */
function lineLabel(line) {
  if (line.network !== 'cer') {
    return line.name;
  }
  return line.nucleo === '51'
    ? `Rodalies ${line.name}`
    : `Cercanías ${line.nucleoName} ${line.name}`;
}

/**
 * @description The name of the device of a line: "Renfe Cercanías Madrid C3".
 * @param {object} line - The line.
 * @returns {string} The name.
 */
function lineDeviceName(line) {
  return `${BRAND} ${lineLabel(line)}`;
}

/**
 * @description When a passage comes, in a sentence: "in 3 min", "at 10:32".
 * @param {object} passage - The passage.
 * @param {object} options - `{ language, now, timeZone }`.
 * @returns {string} The words.
 */
function passageWhen(passage, { language, now, timeZone }) {
  const minutes = minutesLeft(passage, now);
  if (minutes >= 60) {
    return t('atTime', language, { time: formatTime(passage.at, timeZone) });
  }
  return minutes === 0
    ? t('approaching', language).toLowerCase()
    : t('inMinutes', language, { n: minutes });
}

/**
 * @description The short time of a passage, as on the screens of the stops:
 * "3 min", "10:32", "Approaching".
 * @param {object} passage - The passage.
 * @param {object} options - `{ language, now, timeZone }`.
 * @returns {string} The time.
 */
function passageShort(passage, { language, now, timeZone }) {
  const minutes = minutesLeft(passage, now);
  if (minutes >= 60) {
    return formatTime(passage.at, timeZone);
  }
  return minutes === 0 ? t('approaching', language) : t('minutesValue', language, { n: minutes });
}

/**
 * @description One line for a train: "C3 → Aranjuez · 3 min (+2 min de
 * retard) · voie 2 · arr. 22:13".
 * @param {object|null} passage - The train, null when none.
 * @param {object} options - `{ language, now, timeZone }`.
 * @returns {string} The text.
 */
function passageText(passage, options) {
  if (!passage) {
    return t('noPassage', options.language);
  }
  const train = trainLabel(passage);
  const head = passage.destination ? `${train} → ${passage.destination}` : train;
  let mark = '';
  if (!passage.realtime) {
    mark = ` ${t('scheduledMark', options.language)}`;
  } else if (passage.delay > 0) {
    mark = ` ${t('lateMark', options.language, { n: passage.delay })}`;
  }
  const extra = [
    passage.track ? t('trackMark', options.language, { track: passage.track }) : '',
    Number.isFinite(passage.arrival)
      ? t('arrivalMark', options.language, { time: formatTime(passage.arrival, options.timeZone) })
      : '',
  ].filter(Boolean);
  return [`${head} · ${passageShort(passage, options)}${mark}`, ...extra].join(' · ');
}

export {
  LANGUAGES,
  BRAND,
  TEXTS,
  isLanguage,
  t,
  all,
  lineStateText,
  lineLabel,
  lineDeviceName,
  passageWhen,
  passageShort,
  passageText,
};
