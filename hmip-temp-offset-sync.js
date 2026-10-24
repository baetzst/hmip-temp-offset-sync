/**
 * hmip-temp-offset-sync
 *
 * Gleicht die Temperaturmessung von Homematic-IP-Heizkörperthermostaten an einen
 * externen Referenzsensor an (z. B. Zigbee2MQTT), indem der Parameter
 * TEMPERATURE_OFFSET des Thermostats angepasst wird.
 *
 * Läuft im ioBroker-JavaScript-Adapter. Lizenz: MIT (siehe LICENSE).
 *
 * Funktionsprinzip (kurz):
 *   Das Thermostat meldet bereits die offsetkorrigierte Temperatur. Weicht diese
 *   vom Referenzsensor ab, wird der Offset um genau diese Abweichung nachgeführt
 *   (auf 0,5-K-Schritte gerundet, begrenzt auf ±3,5 K).
 *
 * Schutzmechanismen:
 *   - Referenzwert muss eine plausible Zahl und nicht zu alt sein
 *   - ist der Offset noch unbekannt (erster Start), wird er aus der
 *     Gerätekonfiguration gelesen; gelingt das nicht, wird Offset 0 gesendet und
 *     als Startwert gespeichert; ab dem nächsten Zyklus wird geregelt
 *   - Änderungen nur bei ausreichender Abweichung (Hysterese)
 *   - nach einer Änderung wird eine Mindestzeit gewartet und auf einen
 *     neuen Messwert des Thermostats gewartet, bevor erneut gerechnet wird
 *   - ist UNREACH oder CONFIG_PENDING am Thermostat gesetzt (Funkproblem
 *     CCU <-> Thermostat), wird kein neuer Offset gesendet
 *   - Thermostate mit sehr niedriger Solltemperatur (z. B. Abwesenheit) bleiben unberührt
 *   - Trockenlauf-Modus zum gefahrlosen Testen
 */

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

// Ablageort der Status-Datenpunkte (ohne abschließenden Punkt)
const STATE_ROOT = '0_userdata.0.HmIPTempSync';

// Prüfintervall (Cron-Ausdruck)
const CHECK_CRON = '*/30 * * * *';

// Nach einer Änderung mindestens so viele Minuten warten
const MIN_WAIT_MIN = 60;

// Erst ab dieser Abweichung (in K) wird der Offset angepasst.
// Verhindert ständiges Hin- und Herspringen zwischen zwei 0,5-K-Stufen.
const HYSTERESIS = 0.75;

// Abweichung zwischen Thermostat und Referenzsensor (in K), ab der nichts geändert wird.
// Der Offset lässt sich von -3,5 bis +3,5 verstellen, also um höchstens 7 K.
// Der neue Offset wird anschließend auf ±3,5 begrenzt.
const MAX_DEVIATION = 7;

// Referenzsensor darf höchstens so alt sein (Minuten)
const MAX_SENSOR_AGE_MIN = 120;

// true = nur rechnen und loggen, nichts an die Thermostate senden
const DRY_RUN = false;

// Logausgabe
//   LOG_ERROR  Probleme: ungültige oder alte Sensorwerte, UNREACH, CONFIG_PENDING,
//              Lese-/Schreibfehler, unplausible Abweichung
//   LOG_INFO   durchgeführte Änderungen und Prüfungen ohne Änderung
//   LOG_DEBUG  zusätzlich: Gründe, warum in einem Zyklus nicht gerechnet wurde
const LOG_ERROR = true;
const LOG_INFO = true;
const LOG_DEBUG = false;

// Thermostate
//   name       frei wählbar und eindeutig, wird für Log und Datenpunkt-Namen verwendet
//   serial     Seriennummer des Thermostats (Teil des Datenpunkt-Pfads in hm-rpc)
//   instance   Homematic-Instanz, an der das Thermostat hängt (z. B. 'hm-rpc.1')
//   sensor     Datenpunkt des Referenzsensors (Zahl in °C)
//   minSetTemp Nur anpassen, wenn die Solltemperatur mindestens so hoch ist
const THERMOSTATS = [
    { name: 'Wohnzimmer',   instance: 'hm-rpc.1', serial: '00XXXXXXXXXXXX', sensor: 'zigbee2mqtt.0.0xXXXXXXXXXXXXXXXX.temperature', minSetTemp: 15 },
    // { name: 'Schlafzimmer', instance: 'hm-rpc.1', serial: '00YYYYYYYYYYYY', sensor: 'zigbee2mqtt.0.0xYYYYYYYYYYYYYYYY.temperature', minSetTemp: 15 },
    // { name: 'Keller',       instance: 'hm-rpc.2', serial: '00ZZZZZZZZZZZZ', sensor: 'zigbee2mqtt.0.0xZZZZZZZZZZZZZZZZ.temperature', minSetTemp: 15 },
];

// ---------------------------------------------------------------------------
// Ab hier nichts ändern
// ---------------------------------------------------------------------------

const CHANNEL = 1;              // Kanal mit Thermostat-Parametern bei HmIP-Thermostaten
const MAX_OFFSET = 3.5;         // Wertebereich von TEMPERATURE_OFFSET: -3,5 ... +3,5
const REQUEST_TIMEOUT_MS = 30000;

let running = false;

function logError(msg) { if (LOG_ERROR) log(msg, 'error'); }
function logInfo(msg) { if (LOG_INFO) log(msg, 'info'); }
function logDebug(msg) { if (LOG_DEBUG) log(msg, 'debug'); }

function slug(name) {
    return name.replace(/[^A-Za-z0-9_]/g, '_');
}

// auf 0,5-K-Schritte runden und auf den zulässigen Bereich begrenzen
function toStep(value) {
    const stepped = Math.round(value * 2) / 2;
    return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, stepped));
}

function isValidNumber(state, min, max) {
    return !!state && typeof state.val === 'number' && isFinite(state.val)
        && state.val >= min && state.val <= max;
}

// Anfrage an den Homematic-Adapter als Promise
function hmRequest(instance, command, params) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), REQUEST_TIMEOUT_MS);
        sendTo(instance, command, params, res => {
            clearTimeout(timer);
            if (!res) return reject(new Error('keine Antwort'));
            if (res.error) return reject(new Error(String(res.error)));
            resolve(res.result);
        });
    });
}

// Offset aus der Gerätekonfiguration lesen (MASTER-Paramset über den Homematic-Adapter).
// Liefert null, wenn kein plausibler Wert zurückkommt.
async function readOffsetFromCcu(t) {
    const result = await hmRequest(t.hm, 'getParamset',{ ID: `${t.serial}:${CHANNEL}`, paramType: 'MASTER' });
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

// Darf aktuell etwas an das Thermostat gesendet werden?
// Nicht bei Funkproblemen zwischen CCU und Thermostat (UNREACH, CONFIG_PENDING).
async function canSend(t, tag) {
    const unreach = await getStateAsync(`${t.deviceBase}.0.UNREACH`);
    if (unreach && unreach.val === true) {
        logError(`${tag}Thermostat ist nicht erreichbar (UNREACH), nichts gesendet.`);
        return false;
    }
    const pending = await getStateAsync(`${t.deviceBase}.0.CONFIG_PENDING`);
    if (pending && pending.val === true) {
        logError(`${tag}CONFIG_PENDING ist gesetzt (Konfiguration noch nicht übertragen), nichts gesendet.`);
        return false;
    }
    return true;
}

// Erster Lauf: Der Offset ist noch unbekannt (Datenpunkt leer).
// 1. Versuch: Wert aus der Gerätekonfiguration lesen und als Startwert speichern.
// 2. Fallback: Offset 0 senden und als Startwert speichern.
// Ab dem nächsten Zyklus wird normal geregelt.
async function initializeOffset(t, tag) {
    try {
        const fromCcu = await readOffsetFromCcu(t);
        if (fromCcu !== null) {
            await setStateAsync(`${t.stateBase}.offset`, fromCcu, true);
            logInfo(`${tag}Startwert aus der Gerätekonfiguration gelesen: Offset ${fromCcu} K.`);
            return;
        }
        logDebug(`${tag}Kein Offset-Wert aus der Gerätekonfiguration erhalten.`);
    } catch (e) {
        logError(`${tag}Offset konnte nicht gelesen werden: ${e.message}`);
    }
    if (DRY_RUN) {
        logInfo(`${tag}[Trockenlauf] Offset unbekannt, würde Offset 0 senden und als Startwert speichern.`);
        return;
    }
    if (!(await canSend(t, tag))) return;
    await writeOffsetToCcu(t, 0);
    await setStateAsync(`${t.stateBase}.offset`, 0, true);
    await setStateAsync(`${t.stateBase}.lastChange`, Date.now(), true);
    logInfo(`${tag}Offset war unbekannt: Offset 0 gesendet und als Startwert gespeichert.`);
}

async function processThermostat(t) {
    const tag = `[${t.name}] `;
    const now = Date.now();

    // 0. Startwert: noch kein Offset gespeichert -> Offset 0 senden und merken
    const stored = await getStateAsync(`${t.stateBase}.offset`);
    if (!stored || typeof stored.val !== 'number') {
        await initializeOffset(t, tag);
        return;
    }
    const current = stored.val;

    // 1. Referenzsensor prüfen
    const ref = await getStateAsync(t.sensor);
    if (!isValidNumber(ref, -30, 60)) {
        logError(`${tag}Referenzsensor liefert keinen gültigen Wert, übersprungen.`);
        return;
    }
    if (now - ref.ts > MAX_SENSOR_AGE_MIN * 60000) {
        logError(`${tag}Referenzsensor ist älter als ${MAX_SENSOR_AGE_MIN} min, übersprungen.`);
        return;
    }

    // 2. Werte des Thermostats
    const measured = await getStateAsync(`${t.hmBase}.ACTUAL_TEMPERATURE`);
    const setpoint = await getStateAsync(`${t.hmBase}.SET_POINT_TEMPERATURE`);
    if (!isValidNumber(measured, -30, 60) || !isValidNumber(setpoint, 0, 40)) {
        logError(`${tag}Thermostat liefert keine gültigen Werte, übersprungen.`);
        return;
    }
    if (setpoint.val < t.minSetTemp) {
        logDebug(`${tag}Solltemperatur ${setpoint.val} °C unter ${t.minSetTemp} °C, nichts zu tun.`);
        return;
    }

    // 3. Wartezeit und frischer Messwert seit der letzten Änderung
    const lastChangeState = await getStateAsync(`${t.stateBase}.lastChange`);
    const lastChange = lastChangeState && typeof lastChangeState.val === 'number' ? lastChangeState.val : 0;
    if (now - lastChange < MIN_WAIT_MIN * 60000) {
        logDebug(`${tag}Mindestwartezeit seit der letzten Änderung noch nicht erreicht.`);
        return;
    }
    if (measured.ts <= lastChange) {
        logDebug(`${tag}Seit der letzten Änderung kam noch kein neuer Messwert.`);
        return;
    }

    // 4. Abweichung bewerten
    const deviation = ref.val - measured.val;
    if (Math.abs(deviation) > MAX_DEVIATION) {
        logError(`${tag}Abweichung ${deviation.toFixed(2)} K ist unplausibel groß, keine Änderung.`);
        return;
    }
    const status = `Referenz ${ref.val} °C, Thermostat ${measured.val} °C, Abweichung ${deviation.toFixed(2)} K`;
    if (Math.abs(deviation) < HYSTERESIS) {
        logInfo(`${tag}${status}, unter der Schwelle von ${HYSTERESIS} K: Offset bleibt bei ${current} K.`);
        return;
    }
    const next = toStep(current + deviation);
    if (next === current) {
        logInfo(`${tag}${status}: Offset bleibt bei ${current} K (neu berechneter Offset gleich oder Grenze erreicht).`);
        return;
    }

    // 5. Bei Funkproblemen nichts senden
    if (!(await canSend(t, tag))) return;

    // 6. Setzen
    const summary =`Referenz ${ref.val} °C, Thermostat ${measured.val} °C, Offset ${current} → ${next} K`;
    if (DRY_RUN) {
        logInfo(`${tag}[Trockenlauf] ${summary}`);
        return;
    }
    await writeOffsetToCcu(t, next);
    await setStateAsync(`${t.stateBase}.offset`, next, true);
    await setStateAsync(`${t.stateBase}.lastChange`, now, true);
    logInfo(`${tag}${summary}`);
}

async function run() {
    if (running) return;
    running = true;
    try {
        for (const t of THERMOSTATS) {
            try {
                await processThermostat(t);
            } catch (e) {
                logError(`[${t.name}] Fehler: ${e.message}`);
            }
        }
    } finally {
        running = false;
    }
}

async function ensureStates() {
    const slugs = THERMOSTATS.map(t => slug(t.name));
    if (new Set(slugs).size !== slugs.length) {
        throw new Error('Die Namen der Thermostate müssen eindeutig sein.');
    }
    for (const t of THERMOSTATS) {
        for (const field of ['name', 'instance', 'serial', 'sensor']) {
            if (typeof t[field] !== 'string' || !t[field]) {
                throw new Error(`Im Thermostat-Eintrag "${t.name || '?'}" fehlt das Feld "${field}".`);
            }
        }
        t.stateBase = `${STATE_ROOT}.${slug(t.name)}`;
        t.hm = t.instance;
        t.deviceBase = `${t.hm}.${t.serial}`;
        t.hmBase = `${t.deviceBase}.${CHANNEL}`;
        await createStateAsync(`${t.stateBase}.offset`, {
            name: 'Zuletzt gesetzter Offset', type: 'number', role: 'value.temperature',
            unit: 'K', read: true, write: true,
        });
        await createStateAsync(`${t.stateBase}.lastChange`, {
            name: 'Zeitpunkt der letzten Änderung (ms)', type: 'number', role: 'value.time',
            read: true, write: true,
        });
    }
}

async function main() {
    await ensureStates();
    const job = schedule(CHECK_CRON, run);
    onStop(cb => { clearSchedule(job); cb(); }, 1000);
    setTimeout(run, 10000);
}

main().catch(e => log(`Start fehlgeschlagen: ${e.message}`, 'error'));
