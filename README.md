**English** | [Deutsch](README.de.md)

# hmip-temp-offset-sync

An ioBroker script that aligns the temperature reading of **Homematic IP radiator thermostats** with an **external reference sensor** (for example a Zigbee thermometer via Zigbee2MQTT).

Radiator thermostats measure right at the radiator and therefore usually read too high. The script compensates for this by adjusting the thermostat's `TEMPERATURE_OFFSET` parameter, so the control loop works with a temperature closer to the actual room temperature.

## How it works

The thermostat already reports the offset-corrected temperature. The script compares that value with the reference sensor and adjusts the offset by the difference (rounded to 0.5 K steps, limited to ±3.5 K).

Homematic IP thermostats give no feedback on whether a new offset has been applied. The script therefore uses the thermostat's next measurement as the feedback channel and protects itself as follows:

- The reference value must be a plausible number and no older than `MAX_SENSOR_AGE_MIN` minutes (empty battery, sensor offline).
- A change is only made for deviations of at least `HYSTERESIS` kelvin, so the offset does not jump back and forth between two steps (every write costs battery and radio time).
- If the offset is still unknown (first start), it is read from the device configuration. If that fails, offset `0` is sent once and stored as the starting value.
- After a change, the script waits at least `MIN_WAIT_MIN` minutes and for a new thermostat measurement before calculating again.
- If the thermostat is unreachable (`UNREACH`) or an earlier configuration has not been transferred yet (`CONFIG_PENDING`), there is usually a radio problem between the CCU and the thermostat. In that case no new offset is sent. The script checks the datapoints `hm-rpc.<instance>.<serial>.0.UNREACH` and `...0.CONFIG_PENDING`; if one does not exist, that check is skipped.
- If the setpoint is below `minSetTemp` (for example while away), nothing happens.
- Implausibly large deviations (`MAX_DEVIATION`) lead to no change.
- Write errors are detected and logged; the stored offset is only updated after the value has been handed over to the CCU successfully.

## Requirements

- ioBroker with the JavaScript adapter (with `async`/`await` support, so any current version)
- Homematic adapter `hm-rpc` with **HmIP thermostats** integrated (HmIP-eTRV or similar)
- An external temperature sensor whose value is available as a number in °C in a datapoint

Not suitable for classic Homematic thermostats (non-IP), because the offset works differently there.

## Installation

1. Create a new script (JavaScript) in the ioBroker JavaScript adapter.
2. Paste the contents of `hmip-temp-offset-sync.js`.
3. Adjust the configuration at the top of the script (see below).
4. First set `DRY_RUN = true`, start the script and check the log. If the calculated offsets look sensible, set `DRY_RUN = false`.

## Configuration

| Setting | Meaning | Default |
|---|---|---|
| `STATE_ROOT` | Location of the script's status datapoints | `0_userdata.0.HmipTempSync` |
| `CHECK_CRON` | Check interval as a cron expression | every 30 minutes |
| `MIN_WAIT_MIN` | Minimum wait after a change (min) | `60` |
| `HYSTERESIS` | Minimum deviation required for a change (K) | `0.75` |
| `MAX_DEVIATION` | Larger deviations between thermostat and reference are ignored (K). 7 K is the largest possible adjustment range of the offset (−3.5 to +3.5) | `7` |
| `MAX_SENSOR_AGE_MIN` | Maximum age of the reference value (min) | `120` |
| `DRY_RUN` | Only calculate and log | `false` |
| `LOG_ERROR` | Log problems as errors (see "Logging") | `true` |
| `LOG_INFO` | Log changes and checks without a change | `true` |
| `LOG_DEBUG` | Extra detail on why nothing was calculated in a cycle | `false` |

Each thermostat gets one entry in `THERMOSTATS`:

```javascript
{ name: 'Livingroom', instance: 'hm-rpc.1', serial: '00XXXXXXXXXXXX', sensor: 'zigbee2mqtt.0.0xXXXXXXXXXXXXXXXX.temperature', minSetTemp: 15 }
```

`name`, `instance`, `serial` and `sensor` are required; if one is missing, the script stops at startup with an error message. `minSetTemp` is optional (without it the offset is adjusted regardless of the setpoint).

- `name`: freely chosen and unique (used in the log and as datapoint name)
- `instance`: Homematic instance the thermostat is connected to (for example `'hm-rpc.1'`). This allows thermostats from several instances in one script.
- `serial`: serial number of the thermostat, as shown in the object tree under `hm-rpc.<instance>.`
- `sensor`: datapoint of the reference sensor
- `minSetTemp`: only adjust if the setpoint is at least this high

Several thermostats can use the same reference sensor.

## Logging

The three levels can be switched on and off individually. To be notified only about problems, set `LOG_INFO = false`, `LOG_DEBUG = false` and `LOG_ERROR = true`.

- **Error (`LOG_ERROR`)**: reference sensor invalid or too old, thermostat returns no valid values, `UNREACH`, `CONFIG_PENDING`, implausibly large deviation, read or write errors. As long as the problem persists, it is logged again in every cycle.
- **Info (`LOG_INFO`)**: offsets that were set, starting values, and checks where the offset stays unchanged.
- **Debug (`LOG_DEBUG`)**: cycles in which nothing was calculated (minimum wait time, no new measurement yet, setpoint below `minSetTemp`).

Configuration errors (missing required field, duplicate name) are always reported as errors at startup, regardless of `LOG_ERROR`.

## Datapoints

For each thermostat the script creates two datapoints under `STATE_ROOT.<name>`:

- `offset`: last set offset in K (for example `0_userdata.0.HmipTempSync.Livingroom.offset`). This is a datapoint of the script itself, not of the thermostat. It is created by the script on first start and can be overwritten by hand if needed.
- `lastChange`: time of the last change (milliseconds since 1970)

## Starting value of the offset

The offset configured on the thermostat is not a regular datapoint. It can only be read through the device configuration (`getParamset`, MASTER). The CCU may return its cached state, which does not necessarily match the value that is active in the device.

On first start, if the script's `offset` datapoint is still empty:

1. The script reads the value from the device configuration and stores it as the starting value.
2. If that fails, it sends offset `0` to the thermostat in the first cycle and stores `0`. An offset that was set before is reset by this.
3. From the second cycle on, control runs normally.

If the datapoint already exists with a value, that value is used right away. With `DRY_RUN = true` the script only reads and stores; nothing is sent to the thermostat.

## Known limitations

- The thermostat gives no feedback on whether the offset was applied. The script remembers the last value successfully handed over to the CCU.
- Battery-powered thermostats only apply configuration changes at their next radio contact. Do not set the minimum wait time too short.
- The script is meant for HmIP thermostats only and has not been tested with all device variants.
- Comments in the script and log messages are in German.

## Background

The idea of aligning thermostats with an external sensor via the offset comes from the ioBroker community. This project is an **independent reimplementation** and not a fork or derivative of any existing script.

## License

MIT, see [LICENSE](LICENSE).
