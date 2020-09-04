const mqtt = require('mqtt')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const interval = require('interval-promise')
const health = require('homeautomation-js-lib/health.js')
const got = require('got')
const Configstore = require('configstore')
const moment = require('moment-timezone')

const getCurrentTimeZone = function() {
    var TIMEZONE = process.env.TIMEZONE

    if (_.isNil(TIMEZONE)) {
        TIMEZONE = process.env.TZ
    }

    if (_.isNil(TIMEZONE)) {
        TIMEZONE = moment.tz.guess()
    }

    if (_.isNil(TIMEZONE)) {
        TIMEZONE = 'UTC'
    }

    return TIMEZONE
}

const conf = new Configstore('deconz-key', {})

const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')

const TIMEZONE = getCurrentTimeZone()

var deconz_ip = process.env.DECONZ_IP
var deconz_port = process.env.DECONZ_PORT
var deconz_key = conf.get('api-key')

const fix_name = function(str) {
    str = str.replace(/[+\\&*%$#@!]/g, '')
    str = str.replace(/\s/g, '_').trim().toLowerCase()
    str = str.replace(/__/g, '_')
    str = str.replace(/-/g, '_')

    return str
}

const apiURL = function(suffixURL) {
    if (_.isNil(suffixURL)) {
        return ''
    }
    if (_.isNil(deconz_key)) {
        return ''
    }

    return 'http://' + deconz_ip + '/api/' + deconz_key + '/' + suffixURL
}

async function getURL(inURL) {
    const url = apiURL(inURL)

    var result = null
    try {
        const response = await got.get(url)
        result = JSON.parse(response.body)
    } catch (error) {
        logging.error('failed to get url: ' + url + '   error: ' + error)
    }


    return result
}

async function putURL(inURL, bodyJSON) {
    const url = apiURL(inURL)

    var result = null
    try {
        const response = await got.put(url, { json: bodyJSON })
        result = JSON.parse(response.body)
        logging.info('result: ' + JSON.stringify(result))
    } catch (error) {
        logging.error('failed to put url: ' + url + '   error: ' + error)
    }

    return result
}

var lastLightState = null
var lastSensorState = null


const sensorNameForID = function(id) {
    if (!_.isNil(lastSensorState)) {
        const sensorData = lastSensorState[id]

        if (!_.isNil(sensorData)) {
            return fix_name(sensorData.name)
        }
    }

    return id
}

const lightNameForID = function(id) {
    if (!_.isNil(id)) {
        const lightData = lastLightState[id]

        if (!_.isNil(lightData)) {
            return fix_name(lightData.name)
        }
    }

    return null
}

const idForLightName = function(name) {
    var foundDeviceID = null

    if (!_.isNil(lastLightState)) {
        Object.keys(lastLightState).forEach(deviceID => {
            if (!_.isNil(foundDeviceID)) {
                return
            }
            if (fix_name(lastLightState[deviceID].name) === fix_name(name)) {
                foundDeviceID = deviceID
            }
        })
    }

    return foundDeviceID
}

async function queryState() {
    if (_.isNil(deconz_key)) {
        return
    }

    logging.debug('querying state from deconz')

    try {
        logging.debug('starting light query')
        lastLightState = await getURL('lights')
        logging.debug('lastLightState: ' + JSON.stringify(lastLightState))

        Object.keys(lastLightState).forEach(deviceID => {
            var deviceJSON = lastLightState[deviceID]
            deviceJSON.id = deviceID
            deviceJSON.r = 'lights'

            handleUpdateEvent(true, lastLightState[deviceID])
        })
    } catch (error) {
        health.unhealthyEvent()
        logging.error('failed light state update: ' + error)
    }

    try {
        lastSensorState = await getURL('sensors')
        logging.debug('lastSensorState: ' + JSON.stringify(lastSensorState))
        Object.keys(lastSensorState).forEach(deviceID => {
            var deviceJSON = lastSensorState[deviceID]
            deviceJSON.id = deviceID
            deviceJSON.r = 'sensors'

            handleUpdateEvent(true, lastSensorState[deviceID])
        })
    } catch (error) {
        health.unhealthyEvent()
        logging.error('failed sensor state update: ' + error)
    }

}

async function getAPIKey() {
    try {
        const keyURL = 'http://' + deconz_ip + '/api'
        logging.info('Querying API Key URL: ' + keyURL)
        const response = await got.post(keyURL, { json: { devicetype: 'mqtt-bridge' } })
        const body = JSON.parse(response.body)
        const bodyPart = body[0]
        if (!_.isNil(bodyPart) && !_.isNil(bodyPart.success) && !_.isNil(bodyPart.success.username)) {
            const api_key = bodyPart.success.username
            conf.set('api-key', api_key)
            deconz_key = api_key
            logging.info('Saved API Key: ' + api_key)
        } else {
            logging.error('could not get API key: ' + JSON.stringify(body))
        }

    } catch (error) {
        logging.error('failed getting API key: ' + error + '    is the bridge in pairing mode?')
    }
}

if (_.isNil(deconz_key)) {
    logging.info('No saved API Key - Loading API Key')
    getAPIKey()
}

logging.info('Using API Key: ' + deconz_key)
    // Config
var topic_prefix = process.env.TOPIC_PREFIX

if (_.isNil(topic_prefix)) {
    logging.warn('TOPIC_PREFIX not set, not starting')
    process.abort()
}

var mqttOptions = { qos: 1 }

var shouldRetain = process.env.MQTT_RETAIN

if (_.isNil(shouldRetain)) {
    shouldRetain = false
}

if (!_.isNil(shouldRetain)) {
    mqttOptions['retain'] = shouldRetain
}

var connectedEvent = function() {
    client.subscribe(topic_prefix + '/lights/+/+/set', { qos: 1 })
    health.healthyEvent()
    queryState()
}

interval(async() => {
    queryState()
}, 15 * 1000)
queryState()


var disconnectedEvent = function() {
    health.unhealthyEvent()
}

// Setup MQTT
const client = mqtt_helpers.setupClient(connectedEvent, disconnectedEvent)

var isConnected = false
var isConnecting = false

const ReconnectingWebSocket = require('reconnecting-websocket')
const WebSocket = require('ws')
const options = {
    WebSocket: WebSocket
}

const wsURL = 'ws://' + deconz_ip + ':' + deconz_port
const rws = new ReconnectingWebSocket(wsURL, [], options)

rws.addEventListener('open', () => {
    logging.info('Connected to Deconz')
    isConnecting = false
    isConnected = true
    queryState()
})

rws.addEventListener('message', (message) => {
    if (_.isNil(message) || _.isNil(message.data)) {
        logging.error('Received empty message, bailing')
        return
    }
    logging.debug('Received string: ' + message.data)
    const json = JSON.parse(message.data)

    handleJSONEvent(json)
})

const tryReconnect = function() {
    setTimeout(() => {
        if (isConnecting || isConnected) {
            return
        }

        rws.reconnect()
    }, 30000)
}

rws.addEventListener('error', (message) => {
    isConnecting = false
    isConnected = false

    logging.info('Connection error')
    tryReconnect()
})

rws.addEventListener('close', (message) => {
    isConnecting = false
    isConnected = false

    logging.info('Connection closed')
    tryReconnect()
})

const handleJSONEvent = function(json) {
    if (_.isNil(json)) {
        logging.error('Empty JSON to parse')
        return
    }

    switch (json.e) {
        case 'changed':
            handleUpdateEvent(false, json)
            break
    }
}
const cleanupCollection = function(collection) {
    if (_.isNil(collection)) {
        return {}
    }
    var fixed = {}

    Object.keys(collection).forEach(key => {
        var value = collection[key]

        switch (value) {
            case 'true':
            case true:
                value = 1
                break

            case 'false':
            case false:
                value = 0
                break

            default:
                break
        }

        switch (key) {
            case 'temperature':
            case 'humidity':
                value = (value / 100.0).toFixed(2)
                break

            default:
                break
        }


        fixed[key] = value.toString()
    })

    return fixed
}


async function processIncomingMessage(topic, message) {
    if (topic.toString().includes('lights')) {
        const components = topic.split('/')
        var id = components[components.length - 3]
        const action = components[components.length - 2]
        logging.info(' set light id: ' + id + '   action: ' + action + '   to: ' + message)

        if (isNaN(id)) {
            const discoveredID = idForLightName(id)
            if (!_.isNil(discoveredID)) {
                id = discoveredID
            } else {
                logging.error('  bad light id: ' + id)
                return
            }
        }
        if (action.includes('brightness')) {
            const brightness = Number(message)
            const response = await putURL('lights/' + id + '/state', { bri: brightness, on: (brightness > 0 ? true : false) })
            logging.info('brightness update response: ' + response)
        } else if (action.includes('state')) {
            const brightness = Number(message)
            const response = await putURL('lights/' + id + '/state', { on: brightness > 0 ? true : false })
            logging.info('state update response: ' + response)
        }
    }

}

client.on('message', (topic, message) => {
    logging.info(' ' + topic + ':' + message)
    processIncomingMessage(topic, message)
})


const handleUpdateEvent = function(query, json) {
    if (_.isNil(json)) {
        logging.error('Empty update event')
        return
    }

    const deviceType = json.r

    if (_.isNil(deviceType)) {
        logging.error('Empty device type from JSON: ' + JSON.stringify(json))
        return
    }

    if (deviceType == 'sensors' && json.modelid == 'PHDL00' && json.manufacturername == 'Philips') {
        return
    }

    var deviceName = null

    switch (deviceType) {
        case 'lights':
            deviceName = lightNameForID(json.id)
            break
        case 'sensors':
            deviceName = sensorNameForID(json.id)
            break
    }

    if (_.isNil(deviceName)) {
        deviceName = json.id
    }

    const topicPrefix = mqtt_helpers.generateTopic(topic_prefix, deviceType, deviceName)

    var reachable = true
    var state = null

    if (!_.isNil(json.state)) {
        state = cleanupCollection(json.state)
    }

    if (!_.isNil(state) && !_.isNil(state.lastupdated)) {
        const lastupdated = state.lastupdated
        if (lastupdated != 'none') {
            client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'lastupdated'), lastupdated, mqttOptions)
            var now = moment(new Date()).tz(TIMEZONE)
            var dayAgo = moment(now).subtract(4, 'hours')
            var lastUpdatedDate = moment(new Date(lastupdated + 'Z')).tz(TIMEZONE)

            if (lastUpdatedDate < dayAgo) {
                logging.error('  **** not reachable: ' + deviceName)
                client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'reachable'), '0', mqttOptions)
                reachable = false
            } else {
                client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'reachable'), '1', mqttOptions)
            }
        }

        health.healthyEvent()
    }

    if (!reachable) {
        return
    }

    if (!_.isNil(state)) {
        if (!_.isNil(state.buttonevent) && !query) {
            var newOptions = mqttOptions
            newOptions.retain = false
            client.publish(mqtt_helpers.generateTopic(topicPrefix, 'buttonevent'), state.buttonevent, newOptions)
        }

        // Contact
        if (!_.isNil(state.open)) {
            client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'contact'), state.open, mqttOptions)
        }

        // Lights/Switches
        if (!_.isNil(state.bri)) {
            client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'brightness'), state.bri, mqttOptions)

            // This will fall down to state.on if it exists
            if (_.isNil(state.on)) {
                client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'state'), ((state.bri > 0) ? 1 : 0), mqttOptions)
            }
        }

        if (!_.isNil(state.on)) {
            client.smartPublish(mqtt_helpers.generateTopic(topicPrefix, 'state'), state.on, mqttOptions)
        }

        client.smartPublishCollection(topicPrefix, state, ['buttonevent', 'open', 'on', 'bri'], mqttOptions)

        health.healthyEvent()
    }

    if (!_.isNil(json.config)) {
        client.smartPublishCollection(topicPrefix, cleanupCollection(json.config), ['reachable', 'on'], mqttOptions)

        health.healthyEvent()
    }
}