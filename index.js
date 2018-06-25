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

getURL('lights', simpleResponseLog)

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
}

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
      handleChangeEvent(json)
      break;
  }
}

function sensorTypeFromJSON(json) {
  if ( !_.isNil(json.r) ) {
    switch (json.r) {
      case 'lights':
        return 'light'
    }
  }

  if ( !_.isNil(json.config) )
    return 'config'

  if ( !_.isNil(json.state.humidity) || !_.isNil(json.state.temperature) || !_.isNil(json.state.pressure))
    return 'climate'

  if ( !_.isNil(json.state.lux) )
    return 'motion'

  if ( !_.isNil(json.state.presence) )
    return 'motion'

  if ( !_.isNil(json.state.open) )
    return 'contact'

  return null  
}

function handleChangeEvent(json) {
  if (_.isNil(json)) {
    logging.error('Empty change event')
    return
  }

  logging.info('event: ' + JSON.stringify(json))

  switch (sensorTypeFromJSON(json)) {
    case 'light':
      handleLightEvent(json)
      break;
    case 'config':
      handleConfigEvent(json)
      break;
    case 'motion':
      handleMotionEvent(json)
      break;
    case 'climate':
      handleClimateEvent(json)
      break;
    case 'contact':
      handleContactEvent(json)
      break;
  }

}

function handleClimateEvent(json) {
  if (_.isNil(json)) {
    logging.error('Empty climate event')
    return
  }

  logging.info('Climate: ' + JSON.stringify(json))

  if (!_.isNil(json.state.temperature)) {
    client.publish(topic_prefix + '/climate/temperature/' + json.id, parseResult('temperature', json.state.temperature), mqttOptions)
  }
  if (!_.isNil(json.state.humidity)) {
    client.publish(topic_prefix + '/climate/humidity/' + json.id, parseResult('humidity', json.state.humidity), mqttOptions)
  }
  if (!_.isNil(json.state.pressure)) {
    client.publish(topic_prefix + '/climate/pressure/' + json.id, parseResult('pressure', json.state.pressure), mqttOptions)
  }
}

function handleMotionEvent(json) {
  if (_.isNil(json) || _.isNil(json.state)) {
    logging.error('Empty motion event')
    return
  }

  logging.info('Motion: ' + JSON.stringify(json))

  if (!_.isNil(json.state.lux)) {
    client.publish(topic_prefix + '/lux/' + json.id, parseResult('lux', json.state.lux), mqttOptions)
  }
  if (!_.isNil(json.state.dark)) {
    client.publish(topic_prefix + '/dark/' + json.id, parseResult('dark', json.state.dark), mqttOptions)
  }
  if (!_.isNil(json.state.daylight)) {
    client.publish(topic_prefix + '/daylight/' + json.id, parseResult('daylight', json.state.daylight), mqttOptions)
  }
  if (!_.isNil(json.state.lightlevel)) {
    client.publish(topic_prefix + '/lightlevel/' + json.id, parseResult('lightlevel', json.state.lightlevel), mqttOptions)
  }
  if (!_.isNil(json.state.presence)) {
    client.publish(topic_prefix + '/presence/' + json.id, parseResult('presence', json.state.presence), mqttOptions)
  }
}

function handleContactEvent(json) {
  if (_.isNil(json)) {
    logging.error('Empty contact event')
    return
  }

  logging.info('Contact: ' + JSON.stringify(json))

  if (!_.isNil(json.state.open)) {
    client.publish(topic_prefix + '/contact/' + json.id, parseResult('contact', json.state.open), mqttOptions)
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

function handleConfigEvent(json) {
  if (_.isNil(json) || _.isNil(json.config)) {
    logging.error('Empty config event')
    return
  }
  
  logging.info('Config: ' + JSON.stringify(json))

  if (!_.isNil(json.config.battery)) {
    client.publish(topic_prefix + '/battery/' + json.id, parseResult('battery', json.config.battery), mqttOptions)
  }
  if (!_.isNil(json.config.reachable)) {
    client.publish(topic_prefix + '/reachable/' + json.id, parseResult('reachable', json.config.reachable), mqttOptions)
  }

  if (!_.isNil(json.config.temperature)) {
    client.publish(topic_prefix + '/temperature/' + json.id, parseResult('temperature', json.config.temperature), mqttOptions)
  }

}

function handleLightEvent(json) {
  if (_.isNil(json)) {
    logging.error('Empty light event')
    return
  }
  
  logging.info('Config: ' + JSON.stringify(json))

  if (!_.isNil(json.state.bri)) {
    client.publish(topic_prefix + '/light/brightness/' + json.id, parseResult('light', json.state.bri), mqttOptions)
    client.publish(topic_prefix + '/light/state/' + json.id, parseResult('light', json.state.bri > 0 ? 1 : 0 ), mqttOptions)
  }

  if (!_.isNil(json.state.reachable)) {
    client.publish(topic_prefix + '/light/reachable/' + json.id, parseResult('on', json.state.reachable ), mqttOptions)
  }

  if (!_.isNil(json.state.on)) {
    client.publish(topic_prefix + '/light/state/' + json.id, parseResult('on', json.state.on ), mqttOptions)
  }
}


client.on('message', (topic, message) => {
  logging.info(' ' + topic + ':' + message)
  if ( topic.toString().includes('light')) {
      const components = topic.split('/')
      const id = components[components.length - 2]
      const action = components[components.length - 3]
      logging.info(' set light id: ' + id + '   action: ' + action + '   to: ' + message)

      if ( action.includes('brightness')) {
        const brightness = Number(message)
        putURL('lights/' + id + '/state', {bri: brightness, on: (brightness > 0 ? true : false)}, simpleResponseLog)
      } else if ( action.includes('state')) {
        putURL('lights/' + id + '/state', {on: brightness > 0 ? true : false}, simpleResponseLog)
      }
  }
})