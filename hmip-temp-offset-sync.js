/**
 * hmip-temp-offset-sync
 *
 * Aligns the temperature reading of Homematic IP radiator thermostats with an
 * external reference sensor (e.g. Zigbee2MQTT) by adjusting the thermostat's
 * TEMPERATURE_OFFSET parameter.
 *
 * Runs in the ioBroker JavaScript adapter. License: MIT (see LICENSE).
 *
 * How it works (brief):
 *   The thermostat already reports the offset-corrected temperature. If it
 *   deviates from the reference sensor, the offset is adjusted by exactly that
 *   deviation (rounded to 0.5 K steps, limited to ±3.5 K).
 *
 * Safeguards:
 *   - the reference value must be a plausible number and must not be too old
 *   - if the offset is still unknown (first start), it is read from the
 *     device configuration; if that fails, offset 0 is sent and stored as the
 *     initial value; regulation starts with the next cycle
 *   - changes only if the deviation is large enough (hysteresis)
 *   - after a change, a minimum time must pass and a new reading from the
 *     thermostat must arrive before recalculating
 *   - if UNREACH or CONFIG_PENDING is set on the thermostat (radio problem
 *     CCU <-> thermostat), no new offset is sent
 *   - thermostats with a very low setpoint (e.g. away mode) are left untouched
 *   - dry-run mode for safe testing
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Location of the status states (without trailing dot)
const STATE_ROOT = '0_userdata.0.HmIPTempSync';

// Check interval (cron expression)
const CHECK_CRON = '*/30 * * * *';

// Minimum wait time in minutes after a change
const MIN_WAIT_MIN = 60;

// The offset is only adjusted from this deviation (in K) upwards.
// Prevents constant toggling between two 0.5 K steps.
const HYSTERESIS = 0.75;

// Deviation between thermostat and reference sensor (in K) above which nothing is changed.
// The offset can be set from -3.5 to +3.5, i.e. by at most 7 K.
// The new offset is then limited to ±3.5.
const MAX_DEVIATION = 7;

// Maximum age of the reference sensor value (minutes)
const MAX_SENSOR_AGE_MIN = 120;

// true = only calculate and log, send nothing to the thermostats
const DRY_RUN = false;

// Log language: key of a language block in MESSAGES (e.g. 'de', 'en')
const LOG_LANG = 'de';

// Log output
//   LOG_ERROR  problems: invalid or outdated sensor values, UNREACH, CONFIG_PENDING,
//              read/write errors, implausible deviation
//   LOG_INFO   changes made and checks without change
//   LOG_DEBUG  additionally: reasons why no calculation was done in a cycle
const LOG_ERROR = true;
const LOG_INFO = true;
const LOG_DEBUG = false;

// Thermostats
//   name       freely selectable and unique, used for log and state names
//   serial     serial number of the thermostat (part of the state path in hm-rpc)
//   instance   Homematic instance the thermostat is connected to (e.g. 'hm-rpc.1')
//   sensor     state of the reference sensor (number in °C)
//   minSetTemp only adjust if the setpoint is at least this high
const THERMOSTATS = [
    { name: 'Wohnzimmer',   instance: 'hm-rpc.1', serial: '00XXXXXXXXXXXX', sensor: 'zigbee2mqtt.0.0xXXXXXXXXXXXXXXXX.temperature', minSetTemp: 15 },
    // { name: 'Schlafzimmer', instance: 'hm-rpc.1', serial: '00YYYYYYYYYYYY', sensor: 'zigbee2mqtt.0.0xYYYYYYYYYYYYYYYY.temperature', minSetTemp: 15 },
    // { name: 'Keller',       instance: 'hm-rpc.2', serial: '00ZZZZZZZZZZZZ', sensor: 'zigbee2mqtt.0.0xZZZZZZZZZZZZZZZZ.temperature', minSetTemp: 15 },
];

// ---------------------------------------------------------------------------
// Log texts
//   One block per language. To add a language, copy a block, rename the key
//   (e.g. 'fr') and translate the texts. Placeholders in {braces} are filled
//   in at runtime and must be kept unchanged.
//   Missing texts fall back to FALLBACK_LANG.
// ---------------------------------------------------------------------------

const FALLBACK_LANG = 'de';

const MESSAGES = {
    de: {
        timeout:              'Zeitüberschreitung',
        noResponse:           'keine Antwort',
        unreach:              'Thermostat ist nicht erreichbar (UNREACH), nichts gesendet.',
        configPending:        'CONFIG_PENDING ist gesetzt (Konfiguration noch nicht übertragen), nichts gesendet.',
        initFromCcu:          'Startwert aus der Gerätekonfiguration gelesen: Offset {offset} K.',
        initNoCcuValue:       'Kein Offset-Wert aus der Gerätekonfiguration erhalten.',
        initReadFailed:       'Offset konnte nicht gelesen werden: {error}',
        initDryRun:           '[Trockenlauf] Offset unbekannt, würde Offset 0 senden und als Startwert speichern.',
        initSentZero:         'Offset war unbekannt: Offset 0 gesendet und als Startwert gespeichert.',
        refInvalid:           'Referenzsensor liefert keinen gültigen Wert, übersprungen.',
        refTooOld:            'Referenzsensor ist älter als {maxAge} min, übersprungen.',
        thermostatInvalid:    'Thermostat liefert keine gültigen Werte, übersprungen.',
        setpointTooLow:       'Solltemperatur {setpoint} °C unter {minSetTemp} °C, nichts zu tun.',
        waitTimeActive:       'Mindestwartezeit seit der letzten Änderung noch nicht erreicht.',
        noNewReading:         'Seit der letzten Änderung kam noch kein neuer Messwert.',
        deviationImplausible: 'Abweichung {dev} K ist unplausibel groß, keine Änderung.',
        belowHysteresis:      'Referenz {ref} °C, Thermostat {measured} °C, Abweichung {dev} K, unter der Schwelle von {hysteresis} K: Offset bleibt bei {offset} K.',
        offsetUnchanged:      'Referenz {ref} °C, Thermostat {measured} °C, Abweichung {dev} K: Offset bleibt bei {offset} K (neu berechneter Offset gleich oder Grenze erreicht).',
        offsetChanged:        'Referenz {ref} °C, Thermostat {measured} °C, Offset {from} → {to} K',
        offsetChangedDryRun:  '[Trockenlauf] Referenz {ref} °C, Thermostat {measured} °C, Offset {from} → {to} K',
        processError:         'Fehler: {error}',
        namesNotUnique:       'Die Namen der Thermostate müssen eindeutig sein.',
        fieldMissing:         'Im Thermostat-Eintrag "{name}" fehlt das Feld "{field}".',
        stateNameOffset:      'Zuletzt gesetzter Offset',
        stateNameLastChange:  'Zeitpunkt der letzten Änderung (ms)',
        startFailed:          'Start fehlgeschlagen: {error}',
        unknownLang:          'LOG_LANG "{lang}" ist unbekannt, verwende "{fallback}".',
        missingTexts:         'Für LOG_LANG "{lang}" fehlen Texte (Fallback "{fallback}" wird verwendet): {keys}',
    },
    en: {
        timeout:              'timeout',
        noResponse:           'no response',
        unreach:              'Thermostat is unreachable (UNREACH), nothing sent.',
        configPending:        'CONFIG_PENDING is set (configuration not yet transferred), nothing sent.',
        initFromCcu:          'Initial value read from device configuration: offset {offset} K.',
        initNoCcuValue:       'No offset value received from device configuration.',
        initReadFailed:       'Offset could not be read: {error}',
        initDryRun:           '[Dry run] Offset unknown, would send offset 0 and store it as initial value.',
        initSentZero:         'Offset was unknown: offset 0 sent and stored as initial value.',
        refInvalid:           'Reference sensor does not provide a valid value, skipped.',
        refTooOld:            'Reference sensor value is older than {maxAge} min, skipped.',
        thermostatInvalid:    'Thermostat does not provide valid values, skipped.',
        setpointTooLow:       'Setpoint {setpoint} °C below {minSetTemp} °C, nothing to do.',
        waitTimeActive:       'Minimum wait time since the last change not yet reached.',
        noNewReading:         'No new reading received since the last change.',
        deviationImplausible: 'Deviation {dev} K is implausibly large, no change.',
        belowHysteresis:      'Reference {ref} °C, thermostat {measured} °C, deviation {dev} K, below the threshold of {hysteresis} K: offset stays at {offset} K.',
        offsetUnchanged:      'Reference {ref} °C, thermostat {measured} °C, deviation {dev} K: offset stays at {offset} K (recalculated offset unchanged or limit reached).',
        offsetChanged:        'Reference {ref} °C, thermostat {measured} °C, offset {from} → {to} K',
        offsetChangedDryRun:  '[Dry run] Reference {ref} °C, thermostat {measured} °C, offset {from} → {to} K',
        processError:         'Error: {error}',
        namesNotUnique:       'Thermostat names must be unique.',
        fieldMissing:         'Thermostat entry "{name}" is missing the field "{field}".',
        stateNameOffset:      'Last set offset',
        stateNameLastChange:  'Time of last change (ms)',
        startFailed:          'Start failed: {error}',
        unknownLang:          'LOG_LANG "{lang}" is unknown, using "{fallback}".',
        missingTexts:         'Texts missing for LOG_LANG "{lang}" (falling back to "{fallback}"): {keys}',
    },
};

// ---------------------------------------------------------------------------
// Do not change anything below this line
// ---------------------------------------------------------------------------

const CHANNEL = 1;              // channel with thermostat parameters on HmIP thermostats
const MAX_OFFSET = 3.5;         // value range of TEMPERATURE_OFFSET: -3.5 ... +3.5
const REQUEST_TIMEOUT_MS = 30000;

// Active language: LOG_LANG if defined in MESSAGES, otherwise FALLBACK_LANG
const ACTIVE_LANG = MESSAGES[LOG_LANG] ? LOG_LANG : FALLBACK_LANG;

let running = false;

// Get a log text in the active language and fill in placeholders.
// Lookup order: active language -> fallback language -> key itself.
function msg(key, vars = {}) {
    const text = (MESSAGES[ACTIVE_LANG] && MESSAGES[ACTIVE_LANG][key])
        || (MESSAGES[FALLBACK_LANG] && MESSAGES[FALLBACK_LANG][key])
        || key;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

// Warn at startup about an unknown language or missing texts
function checkLanguage() {
    if (!MESSAGES[LOG_LANG]) {
        log(msg('unknownLang', { lang: LOG_LANG, fallback: FALLBACK_LANG }), 'warn');
        return;
    }
    const missing = Object.keys(MESSAGES[FALLBACK_LANG])
        .filter(key => !MESSAGES[LOG_LANG][key]);
    if (missing.length) {
        log(msg('missingTexts', { lang: LOG_LANG, fallback: FALLBACK_LANG, keys: missing.join(', ') }), 'warn');
    }
}

function logError(text) { if (LOG_ERROR) log(text, 'error'); }
function logInfo(text) { if (LOG_INFO) log(text, 'info'); }
function logDebug(text) { if (LOG_DEBUG) log(text, 'debug'); }

function slug(name) {
    return name.replace(/[^A-Za-z0-9_]/g, '_');
}

// Round to 0.5 K steps and limit to the permitted range
function toStep(value) {
    const stepped = Math.round(value * 2) / 2;
    return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, stepped));
}

function isValidNumber(state, min, max) {
    return !!state && typeof state.val === 'number' && isFinite(state.val)
        && state.val >= min && state.val <= max;
}

// Request to the Homematic adapter as a Promise
function hmRequest(instance, command, params) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(msg('timeout'))), REQUEST_TIMEOUT_MS);
        sendTo(instance, command, params, res => {
            clearTimeout(timer);
            if (!res) return reject(new Error(msg('noResponse')));
            if (res.error) return reject(new Error(String(res.error)));
            resolve(res.result);
        });
    });
}

// Read the offset from the device configuration (MASTER paramset via the Homematic adapter).
// Returns null if no plausible value is received.
async function readOffsetFromCcu(t) {
    const result = await hmRequest(t.hm, 'getParamset', { ID: `${t.serial}:${CHANNEL}`, paramType: 'MASTER' });
    const value = result && result.TEMPERATURE_OFFSET;
    return (typeof value === 'number' && isFinite(value) && Math.abs(value) <= MAX_OFFSET) ? value : null;
}

async function writeOffsetToCcu(t, value) {
    await hmRequest(t.hm, 'putParamset', {
        ID: `${t.serial}:${CHANNEL}`,
        paramType: 'MASTER',
        params: { TEMPERATURE_OFFSET: value },
    });
}

// May anything be sent to the thermostat right now?
// Not in case of radio problems between CCU and thermostat (UNREACH, CONFIG_PENDING).
async function canSend(t, tag) {
    const unreach = await getStateAsync(`${t.deviceBase}.0.UNREACH`);
    if (unreach && unreach.val === true) {
        logError(tag + msg('unreach'));
        return false;
    }
    const pending = await getStateAsync(`${t.deviceBase}.0.CONFIG_PENDING`);
    if (pending && pending.val === true) {
        logError(tag + msg('configPending'));
        return false;
    }
    return true;
}

// First run: the offset is still unknown (state empty).
// 1st attempt: read the value from the device configuration and store it as initial value.
// 2nd fallback: send offset 0 and store it as initial value.
// Normal regulation starts with the next cycle.
async function initializeOffset(t, tag) {
    try {
        const fromCcu = await readOffsetFromCcu(t);
        if (fromCcu !== null) {
            await setStateAsync(`${t.stateBase}.offset`, fromCcu, true);
            logInfo(tag + msg('initFromCcu', { offset: fromCcu }));
            return;
        }
        logDebug(tag + msg('initNoCcuValue'));
    } catch (e) {
        logError(tag + msg('initReadFailed', { error: e.message }));
    }
    if (DRY_RUN) {
    
