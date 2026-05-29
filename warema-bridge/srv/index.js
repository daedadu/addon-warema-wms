const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');

const ANGLE_FULLY_OPEN = -100;
const ANGLE_FULLY_CLOSED = 100;

process.on('SIGINT', function () {
    process.exit(0);
});

const mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost'
const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : [];
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : [];
const pollingInterval = process.env.POLLING_INTERVAL || 30000;
const movingInterval = process.env.MOVING_INTERVAL || 1000;
const commandDebounceMs = parseInt(process.env.COMMAND_DEBOUNCE_MS || '200', 10);
const commandMoveMaxRetries = parseInt(process.env.COMMAND_MOVE_MAX_RETRIES || '3', 10);
const commandMoveGapMs = parseInt(process.env.COMMAND_MOVE_GAP_MS || '100', 10);
const commandMoveConfirmTimeoutMs = parseInt(process.env.COMMAND_MOVE_CONFIRM_TIMEOUT_MS || '10000', 10);

const moveQueue = [];
let moveQueueBusy = false;
let currentMove = null;

const settingsPar = {
    wmsChannel: process.env.WMS_CHANNEL || 17,
    wmsKey: process.env.WMS_KEY || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: process.env.WMS_PAN_ID || 'FFFF',
    wmsSerialPort: process.env.WMS_SERIAL_PORT || '/dev/ttyUSB0',
};

const devices = [];
const pendingTargets = {};

function tiltDiscoveryFields(snr) {
    return {
        tilt_status_topic: 'warema/' + snr + '/tilt',
        tilt_command_topic: 'warema/' + snr + '/set_tilt',
        tilt_min: -100,
        tilt_max: 100,
    };
}

function getDeviceState(device) {
    if (!devices[device]) {
        devices[device] = { position: 0, angle: 0 };
    }
    return devices[device];
}

function removeDeviceFromMoveQueue(device) {
    for (let i = moveQueue.length - 1; i >= 0; i--) {
        if (String(moveQueue[i].device) === String(device)) {
            moveQueue.splice(i, 1);
        }
    }
}

function clearCurrentMoveConfirmTimer() {
    if (currentMove?.confirmTimer) {
        clearTimeout(currentMove.confirmTimer);
        currentMove.confirmTimer = null;
    }
}

function finishCurrentMove() {
    clearCurrentMoveConfirmTimer();
    currentMove = null;
    moveQueueBusy = false;
}

function advanceMoveQueue() {
    finishCurrentMove();
    if (commandMoveGapMs > 0) {
        setTimeout(processMoveQueue, commandMoveGapMs);
    } else {
        processMoveQueue();
    }
}

function sendCurrentMove() {
    if (!currentMove) {
        return;
    }

    clearCurrentMoveConfirmTimer();
    log.debug('Moving ' + currentMove.device + ' to position ' + currentMove.position + ', angle ' + currentMove.angle +
        ' (attempt ' + currentMove.attempt + '/' + commandMoveMaxRetries + ')');
    stickUsb.vnBlindSetPosition(currentMove.device, currentMove.position, currentMove.angle);
    currentMove.confirmTimer = setTimeout(function () {
        log.warn('Move confirmation timeout for ' + currentMove.device);
        handleMoveResult(currentMove.device, 'confirm-timeout');
    }, commandMoveConfirmTimeoutMs);
}

function handleMoveResult(device, error) {
    if (!currentMove || String(currentMove.device) !== String(device)) {
        return;
    }

    clearCurrentMoveConfirmTimer();

    if (!error) {
        log.debug('Move confirmed for ' + device);
        advanceMoveQueue();
        return;
    }

    log.warn('Move not confirmed for ' + device + ': ' + error +
        ' (attempt ' + currentMove.attempt + '/' + commandMoveMaxRetries + ')');
    if (currentMove.attempt < commandMoveMaxRetries) {
        currentMove.attempt++;
        sendCurrentMove();
        return;
    }

    log.error('Move failed for ' + device + ' after ' + commandMoveMaxRetries + ' attempts');
    advanceMoveQueue();
}

function cancelCurrentMove(device) {
    if (currentMove && String(currentMove.device) === String(device)) {
        finishCurrentMove();
        processMoveQueue();
    }
}

function processMoveQueue() {
    if (moveQueueBusy || moveQueue.length === 0) {
        return;
    }

    moveQueueBusy = true;
    const next = moveQueue.shift();
    currentMove = {
        device: next.device,
        position: next.position,
        angle: next.angle,
        attempt: 1,
        confirmTimer: null,
    };
    sendCurrentMove();
}

function enqueueBlindMove(device, position, angle) {
    const existing = moveQueue.findIndex(function (item) {
        return item.device === device;
    });
    const entry = { device: device, position: position, angle: angle };

    if (existing >= 0) {
        moveQueue[existing] = entry;
    } else {
        moveQueue.push(entry);
    }

    processMoveQueue();
}

function requestBlindMove(device, updates) {
    const state = getDeviceState(device);

    if (!pendingTargets[device]) {
        pendingTargets[device] = {
            position: state.position,
            angle: state.angle,
            timer: null,
        };
    }

    const pending = pendingTargets[device];
    if (updates.position !== undefined) {
        pending.position = updates.position;
        state.position = updates.position;
    }
    if (updates.angle !== undefined) {
        pending.angle = updates.angle;
        state.angle = updates.angle;
    }

    clearTimeout(pending.timer);
    pending.timer = setTimeout(function () {
        const target = pendingTargets[device];
        delete pendingTargets[device];
        enqueueBlindMove(device, target.position, target.angle);
    }, commandDebounceMs);
}

function registerDevice(element) {
    log.info('Registering ' + element.snr)
    var topic = 'homeassistant/cover/' + element.snr + '/' + element.snr + '/config'
    var availability_topic = 'warema/' + element.snr + '/availability'

    var base_payload = {
        availability: [
            {topic: 'warema/bridge/state'},
            {topic: availability_topic}
        ],
        unique_id: element.snr,
        name: null
    }

    var base_device = {
        identifiers: element.snr,
        manufacturer: "Warema",
        name: element.snr
    }

    var model
    var payload
    switch (parseInt(element.type)) {
        case 6:
            model = 'Weather station eco'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                }
            }

            const illuminance_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/illuminance/state',
                device_class: 'illuminance',
                unique_id: element.snr + '_illuminance',
                object_id: element.snr + '_illuminance',
                unit_of_measurement: 'lx',
            };
            client.publish('homeassistant/sensor/' + element.snr + '/illuminance/config', JSON.stringify(illuminance_payload), {retain: true})

            //No temp on weather station eco
            const temperature_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/temperature/state',
                device_class: 'temperature',
                unique_id: element.snr + '_temperature',
                object_id: element.snr + '_temperature',
                unit_of_measurement: '°C',
            }
            client.publish('homeassistant/sensor/' + element.snr + '/temperature/config', JSON.stringify(temperature_payload), {retain: true})

            const wind_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/wind/state',
                device_class: 'wind_speed',
                unique_id: element.snr + '_wind',
                object_id: element.snr + '_wind',
                unit_of_measurement: 'm/s',
            }
            client.publish('homeassistant/sensor/' + element.snr + '/wind/config', JSON.stringify(wind_payload), {retain: true})

            //No rain on weather station eco
            const rain_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/rain/state',
                device_class: 'moisture',
                unique_id: element.snr + '_rain',
                object_id: element.snr + '_rain',
            }
            client.publish('homeassistant/binary_sensor/' + element.snr + '/rain/config', JSON.stringify(rain_payload), {retain: true})

            client.publish(availability_topic, 'online', {retain: true})

            devices[element.snr] = {};
            // No need to add to stick, updates are broadcasted

            return;
        case 7:
            // WMS Remote pro
            return;
        case 9:
            // WMS WebControl Pro - while part of the network, we have no business to do with it.
            return;
        case 20:
            model = 'Plug receiver'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                position_open: 0,
                position_closed: 100,
                command_topic: 'warema/' + element.snr + '/set',
                state_topic: 'warema/' + element.snr + '/state',
                position_topic: 'warema/' + element.snr + '/position',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                ...tiltDiscoveryFields(element.snr),
            }
            break;
        case 21:
            model = 'Actuator UP'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                position_open: 0,
                position_closed: 100,
                command_topic: 'warema/' + element.snr + '/set',
                position_topic: 'warema/' + element.snr + '/position',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                ...tiltDiscoveryFields(element.snr),
            }

            break;
        case 24:
            // TODO: Smart socket
            model = 'Smart socket';
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                state_topic: 'warema/' + element.snr + '/state',
                command_topic: 'warema/' + element.snr + '/set',
            }

            break;
        case 25:
            model = 'Vertical awning';
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                },
                position_open: 0,
                position_closed: 100,
                state_topic: 'warema/' + element.snr + '/state',
                command_topic: 'warema/' + element.snr + '/set',
                position_topic: 'warema/' + element.snr + '/position',
                set_position_topic: 'warema/' + element.snr + '/set_position',
            }

            break;
        default:
            log.info('Unrecognized device type: ' + element.type)
            model = 'Unknown model ' + element.type
            return
    }

    if (ignoredDevices.includes(element.snr.toString())) {
        log.info('Ignoring and removing device ' + element.snr + ' (type ' + element.type + ')')
    } else {
        log.info('Adding device ' + element.snr + ' (type ' + element.type + ')')

        stickUsb.vnBlindAdd(parseInt(element.snr), element.snr.toString());

        devices[element.snr] = { position: 0, angle: 0 };

        client.publish(availability_topic, 'online', {retain: true})
        client.publish(topic, JSON.stringify(payload), {retain: true})
    }
}

function callback(err, msg) {
    if (err) {
        log.error(err);
    }
    if (msg) {
        switch (msg.topic) {
            case 'wms-vb-init-completion':
                log.info('Warema init completed')

                stickUsb.setCmdConfirmationNotificationEnabled(true);
                stickUsb.setPosUpdInterval(pollingInterval);
                stickUsb.setWatchMovingBlindsInterval(movingInterval);

                log.info('Scanning...')

                stickUsb.scanDevices({autoAssignBlinds: false});
                break;
            case 'wms-vb-scanned-devices':
                log.info('Scanned devices:\n' + JSON.stringify(msg.payload, null, 2));
                if (forceDevices && forceDevices.length) {
                    forceDevices.forEach(deviceString => {
                        const entry = deviceString.trim();
                        const colon = entry.indexOf(':');
                        const snr = colon >= 0 ? entry.slice(0, colon).trim() : entry.trim();
                        const type = colon >= 0 ? entry.slice(colon + 1).trim() : '25';
                        registerDevice({ snr: snr, type: type || '25' });
                    })
                } else {
                    msg.payload.devices.forEach(element => registerDevice(element))
                }
                log.info('Registered devices:\n' + JSON.stringify(stickUsb.vnBlindsList(), null, 2))
                break;
            case 'wms-vb-rcv-weather-broadcast':
                log.silly('Weather broadcast:\n' + JSON.stringify(msg.payload, null, 2))

                if (!devices[msg.payload.weather.snr]) {
                    registerDevice({snr: msg.payload.weather.snr, type: 6});
                }

                client.publish('warema/' + msg.payload.weather.snr + '/illuminance/state', msg.payload.weather.lumen.toString(), {retain: true})
                client.publish('warema/' + msg.payload.weather.snr + '/temperature/state', msg.payload.weather.temp.toString(), {retain: true})
                client.publish('warema/' + msg.payload.weather.snr + '/wind/state', msg.payload.weather.wind.toString(), {retain: true})
                client.publish('warema/' + msg.payload.weather.snr + '/rain/state', msg.payload.weather.rain ? 'ON' : 'OFF', {retain: true})

                break;
            case 'wms-vb-cmd-result-set-position':
                handleMoveResult(msg.payload.snr, msg.payload.error || null);
                break;
            case 'wms-vb-blind-position-update':
                log.debug('Position update: \n' + JSON.stringify(msg.payload, null, 2))

                const snr = msg.payload.snr;
                if (!devices[snr]) devices[snr] = { position: 0, angle: 0 };

                if (typeof msg.payload.position !== "undefined") {
                    devices[snr].position = msg.payload.position;
                    client.publish('warema/' + snr + '/position', '' + msg.payload.position, {retain: true})

                    if (msg.payload.moving === false) {
                        if (msg.payload.position === 0)
                            client.publish('warema/' + snr + '/state', 'open', {retain: true});
                        else if (msg.payload.position === 100)
                            client.publish('warema/' + snr + '/state', 'closed', {retain: true});
                        else
                            client.publish('warema/' + snr + '/state', 'stopped', {retain: true});
                    }
                }
                if (typeof msg.payload.angle !== "undefined") {
                    devices[snr].angle = msg.payload.angle;
                    client.publish('warema/' + snr + '/tilt', '' + msg.payload.angle, {retain: true})
                }
                break;
            default:
                log.info('UNKNOWN MESSAGE: ' + JSON.stringify(msg, null, 2));
        }

        client.publish('warema/bridge/state', 'online', {retain: true})
    }
}

const stickUsb = new warema(settingsPar.wmsSerialPort,
    settingsPar.wmsChannel,
    settingsPar.wmsPanid,
    settingsPar.wmsKey,
    {},
    callback
);

//Do not attempt connecting to MQTT if trying to discover network parameters
if (settingsPar.wmsPanid === 'FFFF') return;

const client = mqtt.connect(mqttServer,
    {
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASSWORD,
        will: {
            topic: 'warema/bridge/state',
            payload: 'offline',
            retain: true
        }
    }
)

client.on('connect', function () {
    log.info('Connected to MQTT')

    client.subscribe([
        'warema/+/set',
        'warema/+/set_position',
        'warema/+/set_tilt',
        'homeassistant/status'
    ]);
})

client.on('error', function (error) {
    log.error('MQTT Error: ' + error.toString())
})

client.on('message', function (topic, message) {
    let [scope, device, command] = topic.split('/');
    message = message.toString();

    log.debug('Received message on topic')
    log.debug('scope: ' + scope + ', device: ' + device + ', command: ' + command)
    log.debug('message: ' + message)

    if (scope === 'homeassistant' && command === 'status') {
        if (message === 'online') {
            log.info('Home Assistant is online');
        }
        return;
    }

    //scope === 'warema'
    switch (command) {
        case 'set':
            switch (message) {
                case 'ON':
                case 'OFF':
                    //TODO: use stick to turn on/off
                    break;
                case 'CLOSE':
                    log.debug('Closing ' + device);
                    requestBlindMove(device, {
                        position: 100,
                        angle: ANGLE_FULLY_CLOSED,
                    });
                    client.publish('warema/' + device + '/state', 'closing');
                    break;
                case 'OPEN':
                    log.debug('Opening ' + device);
                    requestBlindMove(device, {
                        position: 0,
                        angle: ANGLE_FULLY_OPEN,
                    });
                    client.publish('warema/' + device + '/state', 'opening');
                    break;
                case 'STOP':
                    log.debug('Stopping ' + device);
                    if (pendingTargets[device]?.timer) {
                        clearTimeout(pendingTargets[device].timer);
                        delete pendingTargets[device];
                    }
                    removeDeviceFromMoveQueue(device);
                    cancelCurrentMove(device);
                    stickUsb.vnBlindStop(device);
                    break;
            }
            break;
        case 'set_position':
            log.debug('Setting ' + device + ' to ' + message + '%, angle ' + (devices[device]?.angle ?? 0));
            requestBlindMove(device, { position: parseInt(message, 10) });
            break;
        case 'set_tilt':
            log.debug('Setting tilt ' + device + ' to ' + message + '°, position ' + (devices[device]?.position ?? 0));
            requestBlindMove(device, { angle: parseInt(message, 10) });
            break;
        default:
            log.info('Unrecognised command from HA')
    }
});
