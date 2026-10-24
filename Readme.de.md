[English](README.md) | **Deutsch**

# hmip-temp-offset-sync

ioBroker-Script, das die Temperaturmessung von **Homematic-IP-Heizkörperthermostaten** an einen **externen Referenzsensor** angleicht (z. B. ein Zigbee-Thermometer über Zigbee2MQTT).

Heizkörperthermostate messen direkt am Heizkörper und zeigen deshalb meist zu hohe Werte. Das Script gleicht das aus, indem es den Parameter `TEMPERATURE_OFFSET` des Thermostats nachführt. Die Regelung arbeitet danach mit einer Temperatur, die näher an der Raumtemperatur liegt.

## Funktionsweise

Das Thermostat meldet bereits die um den Offset korrigierte Temperatur. Das Script vergleicht diesen Wert mit dem Referenzsensor und führt den Offset um die Abweichung nach (gerundet auf 0,5-K-Schritte, begrenzt auf ±3,5 K).

Die Homematic-IP-Thermostate liefern keine Rückmeldung, ob ein neuer Offset übernommen wurde. Das Script verlässt sich deshalb auf den nächsten Messwert des Thermostats als Rückkanal und schützt sich wie folgt:

- Der Referenzwert muss eine plausible Zahl sein und darf nicht älter als `MAX_SENSOR_AGE_MIN` Minuten sein (leere Batterie, Sensor offline).
- Eine Änderung erfolgt nur bei Abweichungen ab `HYSTERESIS` Kelvin, damit der Offset nicht zwischen zwei Stufen hin und her springt (jeder Schreibzugriff kostet Batterie und Funkzeit).
- Ist der Offset noch unbekannt (erster Start), wird er aus der Gerätekonfiguration gelesen. Gelingt das nicht, wird einmalig Offset `0` gesendet und als Startwert gespeichert.
- Nach einer Änderung wird mindestens `MIN_WAIT_MIN` Minuten gewartet und ein neuer Messwert des Thermostats abgewartet, bevor erneut gerechnet wird.
- Ist das Thermostat nicht erreichbar (`UNREACH`) oder wurde eine frühere Konfiguration noch nicht übertragen (`CONFIG_PENDING`), liegt meist ein Funkproblem zwischen CCU und Thermostat vor. Dann wird kein neuer Offset gesendet. Geprüft werden die Datenpunkte `hm-rpc.<Instanz>.<Seriennummer>.0.UNREACH` und `...0.CONFIG_PENDING`; fehlt einer davon, wird die jeweilige Prüfung übersprungen.
- Ist die Solltemperatur kleiner als `minSetTemp` (z. B. Abwesenheit), passiert nichts.
- Unplausibel große Abweichungen (`MAX_DEVIATION`) führen zu keiner Änderung.
- Fehler beim Schreiben werden erkannt und geloggt; der gespeicherte Offset wird nur nach erfolgreicher Übergabe an die CCU aktualisiert.

## Voraussetzungen

- ioBroker mit JavaScript-Adapter (mit Unterstützung für `async`/`await`, also jede aktuelle Version)
- Homematic-Adapter `hm-rpc` mit eingebundenen **HmIP-Thermostaten** (HmIP-eTRV o. Ä.)
- Ein externer Temperatursensor, dessen Wert als Zahl in °C in einem Datenpunkt liegt

Nicht geeignet für Thermostate der klassischen Homematic-Reihe (nicht IP), weil dort der Offset anders funktioniert.

## Installation

1. Im ioBroker-JavaScript-Adapter ein neues Script (JavaScript) anlegen.
2. Inhalt von `hmip-temp-offset-sync.js` einfügen.
3. Konfiguration oben im Script anpassen (siehe unten).
4. Zuerst `DRY_RUN = true` setzen, Script starten und das Log prüfen. Wenn die berechneten Offsets sinnvoll aussehen, `DRY_RUN = false` setzen.

## Konfiguration

| Einstellung | Bedeutung | Standard |
|---|---|---|
| `STATE_ROOT` | Ablageort der Status-Datenpunkte | `0_userdata.0.HmipTempSync` |
| `CHECK_CRON` | Prüfintervall als Cron-Ausdruck | alle 30 Minuten |
| `MIN_WAIT_MIN` | Mindestwartezeit nach einer Änderung (min) | `60` |
| `HYSTERESIS` | Mindestabweichung für eine Änderung (K) | `0.75` |
| `MAX_DEVIATION` | Größere Abweichungen zwischen Thermostat und Referenz werden ignoriert (K). 7 K entspricht dem größtmöglichen Verstellbereich des Offsets (−3,5 bis +3,5) | `7` |
| `MAX_SENSOR_AGE_MIN` | Maximales Alter des Referenzwerts (min) | `120` |
| `DRY_RUN` | Nur berechnen und loggen | `false` |
| `LOG_ERROR` | Probleme als Fehler loggen (siehe „Logausgabe“) | `true` |
| `LOG_INFO` | Änderungen und Prüfungen ohne Änderung loggen | `true` |
| `LOG_DEBUG` | zusätzliche Details, warum in einem Zyklus nicht gerechnet wurde | `false` |

Pro Thermostat wird ein Eintrag in `THERMOSTATS` angelegt:

```javascript
{ name: 'Wohnzimmer', instance: 'hm-rpc.1', serial: '00XXXXXXXXXXXX', sensor: 'zigbee2mqtt.0.0xXXXXXXXXXXXXXXXX.temperature', minSetTemp: 15 }
```

`name`, `instance`, `serial` und `sensor` sind Pflicht; fehlt eines davon, bricht das Script beim Start mit einer Fehlermeldung ab. `minSetTemp` ist optional (ohne Angabe wird unabhängig von der Solltemperatur angepasst).

- `name`: frei wählbar und eindeutig (Log und Datenpunkt-Name)
- `instance`: Homematic-Instanz, an der das Thermostat hängt (z. B. `'hm-rpc.1'`). Dadurch können Thermostate mehrerer Instanzen in einem Script laufen.
- `serial`: Seriennummer des Thermostats, wie sie im Objektbaum unter `hm-rpc.<Instanz>.` steht
- `sensor`: Datenpunkt des Referenzsensors
- `minSetTemp`: nur anpassen, wenn die Solltemperatur mindestens so hoch ist

Mehrere Thermostate können denselben Referenzsensor verwenden.

## Logausgabe

Die drei Stufen lassen sich einzeln ein- und ausschalten. Wer nur auf Probleme aufmerksam gemacht werden möchte, setzt `LOG_INFO = false`, `LOG_DEBUG = false` und `LOG_ERROR = true`.

- **Fehler (`LOG_ERROR`)**: Referenzsensor ungültig oder zu alt, Thermostat liefert keine gültigen Werte, `UNREACH`, `CONFIG_PENDING`, unplausibel große Abweichung, Lese- oder Schreibfehler. Solange das Problem besteht, wird es in jedem Zyklus erneut geloggt.
- **Info (`LOG_INFO`)**: gesetzte Offsets, Startwerte und Prüfungen, bei denen der Offset unverändert bleibt.
- **Debug (`LOG_DEBUG`)**: Zyklen, in denen nicht gerechnet wurde (Mindestwartezeit, noch kein neuer Messwert, Solltemperatur unter `minSetTemp`).

Fehler bei der Konfiguration (fehlendes Pflichtfeld, doppelter Name) werden beim Start immer als Fehler ausgegeben, unabhängig von `LOG_ERROR`.

## Datenpunkte

Pro Thermostat legt das Script unter `STATE_ROOT.<name>` zwei Datenpunkte an:

- `offset`: zuletzt gesetzter Offset in K (z. B. `0_userdata.0.HmipTempSync.Wohnzimmer.offset`). Das ist ein eigener Datenpunkt des Scripts, kein Datenpunkt des Thermostats. Er wird beim ersten Start vom Script angelegt und kann bei Bedarf von Hand überschrieben werden.
- `lastChange`: Zeitpunkt der letzten Änderung (Millisekunden seit 1970)

## Startwert des Offsets

Der am Thermostat eingestellte Offset ist kein normaler Datenpunkt. Er lässt sich nur über die Gerätekonfiguration lesen (`getParamset`, MASTER). Dabei liefert die CCU eventuell ihren zwischengespeicherten Stand, der nicht zwingend dem im Gerät aktiven Wert entspricht.

Beim ersten Start gilt, wenn der Datenpunkt `offset` des Scripts noch leer ist:

1. Das Script liest den Wert aus der Gerätekonfiguration und speichert ihn als Startwert.
2. Gelingt das nicht, sendet es im ersten Zyklus Offset `0` an das Thermostat und speichert `0`. Ein vorher eingestellter Offset wird dadurch zurückgesetzt.
3. Ab dem zweiten Zyklus wird normal geregelt.

Existiert der Datenpunkt bereits mit einem Wert, wird direkt damit gerechnet. Mit `DRY_RUN = true` wird nur gelesen und gespeichert, aber nichts an das Thermostat gesendet.

## Bekannte Einschränkungen

- Es gibt keine Rückmeldung vom Thermostat, ob der Offset übernommen wurde. Das Script merkt sich den zuletzt erfolgreich an die CCU übergebenen Wert.
- Batteriebetriebene Thermostate übernehmen Konfigurationsänderungen erst beim nächsten Funkkontakt. Deshalb die Mindestwartezeit nicht zu kurz wählen.
- Das Script ist nur mit HmIP-Thermostaten gedacht und wurde nicht mit allen Gerätevarianten getestet.
- Kommentare im Script und Logmeldungen sind auf Deutsch.

## Hintergrund

Die Idee, Thermostate per Offset an einen externen Sensor anzugleichen, stammt aus der ioBroker-Community. Dieses Projekt ist eine **eigenständige Neuimplementierung** und kein Fork oder Derivat eines bestehenden Scripts.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
