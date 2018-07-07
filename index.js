const mqtt = require('mqtt')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const repeat = require('repeat')
const bodyParser = require('body-parser')
const health = require('homeautomation-js-lib/health.js')
const request = require('request')
const Configstore = require('configstore');

const conf = new Configstore("deconz-key", {});

require('homeautomation-js-lib/mqtt_helpers.js')

var deconz_ip = process.env.DECONZ_IP
var deconz_port = process.env.DECONZ_PORT
var deconz_key = conf.get('api-key')

function fix_name(str) {
  str = str.replace(/[+\\\&\*\%\$\#\@\!]/g, '')
  str = str.replace(/\s/g, '_').trim().toLowerCase()
  str = str.replace(/__/g, '_')
  str = str.replace(/-/g, '_')

  return str
}

function apiURL(suffixURL) {
  if ( _.isNil(suffixURL ) ) return ""
  if ( _.isNil(deconz_key ) ) return ""
  
  return 'http://' + deconz_ip + '/api/' + deconz_key + '/' + suffixURL
}

function getURL(inURL, response) {
  const url = apiURL(inURL)

  request.get(url, {json:true}, response)
}

function putURL(inURL, bodyJSON, response) {
  const url = apiURL(inURL)

  request.put(url, {body:bodyJSON, json:true}, response)
}

const simpleResponseLog = function(err,httpResponse,body){ 
  logging.info('reponse error: ' + err)
  logging.info('httpResponse error: ' + JSON.stringify(httpResponse))
  logging.info('reponse body: ' + JSON.stringify(body))
  }


var lastLightState = null
var lastSensorState = null


const sensorNameForID = function(id) {
  if ( !_.isNil(lastSensorState) ) {
    const sensorData = lastSensorState[id]

    if ( !_.isNil(sensorData) )
      return fix_name(sensorData.name)
  }

  return id
}

const lightNameForID = function(id) {
  if ( !_.isNil(id) ) {
    const lightData = lastLightState[id]

    if ( !_.isNil(lightData) )
      return fix_name(lightData.name)
  }

  return null
}

const idForLightName = function(name) {
  if ( !_.isNil(lastLightState) ) {
    Object.keys(lastLightState).forEach(deviceID => {
        if ( lastLightState[deviceID].name === name ) {
          return deviceID
        }
      })
    }

  return null
}

const queryState = function() {
  if ( _.isNil(deconz_key) )
    return
  
  logging.info('querying state from deconz')

  getURL('lights', function(err,httpResponse,body){ 
    if ( !_.isNil(body) ) {
      lastLightState = body
      logging.info('lastLightState: ' + JSON.stringify(lastLightState))

      Object.keys(lastLightState).forEach(deviceID => {
          var deviceJSON = lastLightState[deviceID]
          deviceJSON.id = deviceID
          deviceJSON.r = 'lights'
          handleUpdateEvent(lastLightState[deviceID])
        });
      }
  })
  getURL('sensors', function(err,httpResponse,body){ 
    if ( !_.isNil(body) ) {
      lastSensorState = body
      logging.info('lastSensorState: ' + JSON.stringify(lastSensorState))
      Object.keys(lastSensorState).forEach(deviceID => {
        var deviceJSON = lastSensorState[deviceID]
        deviceJSON.id = deviceID
        deviceJSON.r = 'sensors'
        handleUpdateEvent(lastSensorState[deviceID])
      });
    }
  })
}

if ( _.isNil(deconz_key) ) {
  logging.info('No saved API Key - Loading API Key')
  request.post('http://' + deconz_ip + '/api', {body:{devicetype:'mqtt-bridge'}, json:true},
      function(err,httpResponse,body){ 
        logging.info('reponse body: ' + JSON.stringify(body))
        const bodyPart = body[0]
        if ( !_.isNil(bodyPart) && !_.isNil(bodyPart.success) && !_.isNil(bodyPart.success.username) ) {
          const api_key = bodyPart.success.username
          conf.set('api-key', api_key)
          deconz_key = api_key
          logging.info('Saved API Key: ' + api_key)
        } else {
          logging.error('could not get API key: ' + JSON.stringify(body))
        }
      }
  )
}

logging.info('Using API Key: ' + deconz_key)
  // Config
var topic_prefix = process.env.TOPIC_PREFIX

if (_.isNil(topic_prefix)) {
    logging.warn('TOPIC_PREFIX not set, not starting')
    process.abort()
}

var mqttOptions = {}

var shouldRetain = process.env.MQTT_RETAIN

if (_.isNil(shouldRetain)) {
    shouldRetain = true
}

if (!_.isNil(shouldRetain)) {
    mqttOptions['retain'] = shouldRetain
}

var connectedEvent = function() {
  client.subscribe(topic_prefix + '/light/+/+/set')
  health.healthyEvent()
  queryState()
}

repeat(queryState).every(15, 's').start.in(10, 'sec')

var disconnectedEvent = function() {
    health.unhealthyEvent()
}

// Setup MQTT
const client = mqtt.setupClient(connectedEvent, disconnectedEvent)

var isConnected = false
var isConnecting = false

const ReconnectingWebSocket = require('reconnecting-websocket')
const WebSocket = require('ws')
const options = {
  WebSocket: WebSocket
};

const wsURL = 'ws://' + deconz_ip + ':' + deconz_port
const rws = new ReconnectingWebSocket(wsURL, [], options);

rws.addEventListener('open', () => {
  logging.info('Connected to Deconz')
  isConnecting = false
  isConnected = true
  queryState()
});

rws.addEventListener('message', (message) => {
  if (_.isNil(message) || _.isNil(message.data)) {
    logging.error('Received empty message, bailing')
    return
  }
  logging.info('Received string: ' + message.data)
  const json = JSON.parse(message.data)

  handleJSONEvent(json)
})


function tryReconnect() {
  setTimeout(() => {
    if ( isConnecting || isConnected )
      return

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


function handleJSONEvent(json) {
  if (_.isNil(json)) {
    logging.error('Empty JSON to parse')
    return
  }

  switch (json.e) {
    case 'changed':
      handleUpdateEvent(json)
      break;
  }
}

function parseResult(key, value) {
  if ( _.isNil(value) )
    return "0"
  if ( value == true )
    return "1"
  if ( value == false )
    return "0"


  if ( key == 'temperature' )
    return (value / 100.0).toFixed(2).toString()

  if ( key == 'humidity' )
    return (value / 100.0).toFixed(2).toString()

  return value.toString()
}

client.on('message', (topic, message) => {
  logging.info(' ' + topic + ':' + message)
  if ( topic.toString().includes('light')) {
      const components = topic.split('/')
      var id = components[components.length - 3]
      const action = components[components.length - 2]
      logging.info(' set light id: ' + id + '   action: ' + action + '   to: ' + message)

      if ( isNaN(id) ) {
        const discoveredID = idForLightName(id)
        if ( !_.isNil(discoveredID) ) {
          id = discoveredID
        } else {
          logging.error('  bad light id: ' + id)
          return
        }
      }
      if ( action.includes('brightness')) {
        const brightness = Number(message)
        putURL('lights/' + id + '/state', {bri: brightness, on: (brightness > 0 ? true : false)}, simpleResponseLog)
      } else if ( action.includes('state')) {
        putURL('lights/' + id + '/state', {on: brightness > 0 ? true : false}, simpleResponseLog)
      }
  }
})

function handleUpdateEvent(json) {
  if (_.isNil(json) ) {
    logging.error('Empty update event')
    return
  }
  
  const deviceType = json.r

  if ( _.isNil(deviceType)) {
    logging.error('Empty device type from JSON: ' + JSON.stringify(json))
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

  if ( _.isNil(deviceName) ) {
    deviceName = json.id
  }
  
  const topicPrefix = topic_prefix + '/' + deviceType + '/' + deviceName + '/'

  if ( !_.isNil(json.state)) {

    // Climate
    if (!_.isNil(json.state.temperature)) {
      client.smartPublish(topicPrefix + 'temperature', parseResult('temperature', json.state.temperature), mqttOptions)
    }
    if (!_.isNil(json.state.humidity)) {
      client.smartPublish(topicPrefix + 'humidity', parseResult('humidity', json.state.humidity), mqttOptions)
    }
    if (!_.isNil(json.state.pressure)) {
      client.smartPublish(topicPrefix + 'pressure', parseResult('pressure', json.state.pressure), mqttOptions)
    }

    // Motion/Light
    if (!_.isNil(json.state.lux)) {
      client.smartPublish(topicPrefix + 'lux', parseResult('lux', json.state.lux), mqttOptions)
    }
    if (!_.isNil(json.state.dark)) {
      client.smartPublish(topicPrefix + 'dark', parseResult('dark', json.state.dark), mqttOptions)
    }
    if (!_.isNil(json.state.daylight)) {
      client.smartPublish(topicPrefix + 'daylight', parseResult('daylight', json.state.daylight), mqttOptions)
    }
    if (!_.isNil(json.state.lightlevel)) {
      client.smartPublish(topicPrefix + 'lightlevel', parseResult('lightlevel', json.state.lightlevel), mqttOptions)
    }
    if (!_.isNil(json.state.presence)) {
      client.smartPublish(topicPrefix + 'presence', parseResult('presence', json.state.presence), mqttOptions)
    }
  
    // Lights/Switches
    if (!_.isNil(json.state.bri)) {
      client.smartPublish(topicPrefix + 'brightness', parseResult('light', json.state.bri), mqttOptions)
      client.smartPublish(topicPrefix + 'state', parseResult('light', json.state.bri > 0 ? 1 : 0 ), mqttOptions)
    }
    if (!_.isNil(json.state.on)) {
      client.smartPublish(topicPrefix + 'state', parseResult('on', json.state.on ), mqttOptions)
    }

    if (!_.isNil(json.state.effect)) {
      client.smartPublish(topicPrefix + 'effect', parseResult('effect', json.state.effect ), mqttOptions)
    }

    if (!_.isNil(json.state.effect)) {
      client.smartPublish(topicPrefix + 'effect', parseResult('effect', json.state.effect ), mqttOptions)
    }

    if (!_.isNil(json.state.sat)) {
      client.smartPublish(topicPrefix + 'sat', parseResult('sat', json.state.sat ), mqttOptions)
    }

    if (!_.isNil(json.state.xy)) {
      client.smartPublish(topicPrefix + 'xy', parseResult('xy', json.state.xy ), mqttOptions)
    }

    if (!_.isNil(json.state.hue)) {
      client.smartPublish(topicPrefix + 'hue', parseResult('hue', json.state.hue ), mqttOptions)
    }

    if (!_.isNil(json.state.alert)) {
      client.smartPublish(topicPrefix + 'alert', parseResult('alert', json.state.alert ), mqttOptions)
    }

    if (!_.isNil(json.state.ct)) {
      client.smartPublish(topicPrefix + 'ct', parseResult('ct', json.state.ct ), mqttOptions)
    }

    // Contact
    if (!_.isNil(json.state.open)) {
      client.smartPublish(topicPrefix + 'contact', parseResult('contact', json.state.open), mqttOptions)
    }

    // Contact
    if (!_.isNil(json.state.lastupdated)) {
      client.smartPublish(topicPrefix + 'lastupdated', parseResult('date', json.state.lastupdated), mqttOptions)
    }
  }

  if ( !_.isNil(json.config)) {
    logging.info('Config: ' + JSON.stringify(json))

    // Battery / Reachable
    if (!_.isNil(json.config.battery)) {
      client.smartPublish(topicPrefix + 'battery', parseResult('battery', json.config.battery), mqttOptions)
    }
    if (!_.isNil(json.config.reachable)) {
      client.smartPublish(topicPrefix + 'reachable', parseResult('reachable', json.config.reachable), mqttOptions)
    }

    if (!_.isNil(json.config.on)) {
      client.smartPublish(topicPrefix + 'state', parseResult('on', json.config.on ), mqttOptions)
    }

    // Climate
    if (!_.isNil(json.config.temperature)) {
      client.smartPublish(topicPrefix + 'temperature', parseResult('temperature', json.config.temperature), mqttOptions)
    }
  }
}
