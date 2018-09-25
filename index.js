const mqtt = require('mqtt')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const repeat = require('repeat')
const health = require('homeautomation-js-lib/health.js')
const request = require('request')
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

require('homeautomation-js-lib/mqtt_helpers.js')

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
	if ( _.isNil(suffixURL) ) { 
		return ''
	}
	if ( _.isNil(deconz_key) ) { 
		return '' 
	}
  
	return 'http://' + deconz_ip + '/api/' + deconz_key + '/' + suffixURL
}

const getURL = function(inURL, response) {
	const url = apiURL(inURL)

	request.get(url, {json:true}, response)
}

const putURL = function(inURL, bodyJSON, response) {
	const url = apiURL(inURL)

	request.put(url, {body:bodyJSON, json:true}, response)
}

const simpleResponseLog = function(err, httpResponse, body){ 
	logging.info('reponse error: ' + err)
	logging.info('httpResponse error: ' + JSON.stringify(httpResponse))
	logging.info('reponse body: ' + JSON.stringify(body))
}


var lastLightState = null
var lastSensorState = null


const sensorNameForID = function(id) {
	if ( !_.isNil(lastSensorState) ) {
		const sensorData = lastSensorState[id]

		if ( !_.isNil(sensorData) ) {
			return fix_name(sensorData.name) 
		}
	}

	return id
}

const lightNameForID = function(id) {
	if ( !_.isNil(id) ) {
		const lightData = lastLightState[id]

		if ( !_.isNil(lightData) ) { 
			return fix_name(lightData.name) 
		}
	}

	return null
}

const idForLightName = function(name) {
	var foundDeviceID = null

	if ( !_.isNil(lastLightState) ) {
		Object.keys(lastLightState).forEach(deviceID => {
			if ( !_.isNil(foundDeviceID)) {
				return 
			}
			if ( fix_name(lastLightState[deviceID].name) === fix_name(name) ) {
				foundDeviceID = deviceID
			}
		})
	}

	return foundDeviceID
}

const queryState = function() {
	if ( _.isNil(deconz_key) ) { 
		return
	}
  
	logging.info('querying state from deconz')

	getURL('lights', function(err, httpResponse, body){ 
		if ( !_.isNil(body) ) {
			lastLightState = body
			logging.info('lastLightState: ' + JSON.stringify(lastLightState))

			Object.keys(lastLightState).forEach(deviceID => {
				var deviceJSON = lastLightState[deviceID]
				deviceJSON.id = deviceID
				deviceJSON.r = 'lights'
        
				handleUpdateEvent(true, lastLightState[deviceID])
			})
		}
	})
	getURL('sensors', function(err, httpResponse, body){ 
		if ( !_.isNil(body) ) {
			lastSensorState = body
			logging.info('lastSensorState: ' + JSON.stringify(lastSensorState))
			Object.keys(lastSensorState).forEach(deviceID => {
				var deviceJSON = lastSensorState[deviceID]
				deviceJSON.id = deviceID
				deviceJSON.r = 'sensors'
        
				handleUpdateEvent(true, lastSensorState[deviceID])
			})
		}
	})
}

if ( _.isNil(deconz_key) ) {
	logging.info('No saved API Key - Loading API Key')
	request.post('http://' + deconz_ip + '/api', {body:{devicetype:'mqtt-bridge'}, json:true},
		function(err, httpResponse, body){ 
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
	shouldRetain = false
}

if (!_.isNil(shouldRetain)) {
	mqttOptions['retain'] = shouldRetain
}

var connectedEvent = function() {
	client.subscribe(topic_prefix + '/lights/+/+/set')
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
	logging.info('Received string: ' + message.data)
	const json = JSON.parse(message.data)

	handleJSONEvent(json)
})

const tryReconnect = function() {
	setTimeout(() => {
		if ( isConnecting || isConnected ) {
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

const parseResult = function(key, value) {  
	if ( _.isNil(value) ) { 
		return '0'
	}
	if ( value == true ) {
		return '1'
	}
	if ( value == false ) { 
		return '0' 
	}


	if ( key == 'temperature' ) { 
		return (value / 100.0).toFixed(2).toString()
	}

	if ( key == 'humidity' ) {
		return (value / 100.0).toFixed(2).toString()
	}

	return value.toString()
}

client.on('message', (topic, message) => {
	logging.info(' ' + topic + ':' + message)
	if ( topic.toString().includes('lights')) {
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
			const brightness = Number(message)
			putURL('lights/' + id + '/state', {on: brightness > 0 ? true : false}, simpleResponseLog)
		}
	}
})

const climateHandler = function(query, topicPrefix, state) {
	// Climate
	if (!_.isNil(state.temperature)) {
		client.smartPublish(topicPrefix + 'temperature', parseResult('temperature', state.temperature), mqttOptions)
	}
	if (!_.isNil(state.humidity)) {
		client.smartPublish(topicPrefix + 'humidity', parseResult('humidity', state.humidity), mqttOptions)
	}
	if (!_.isNil(state.pressure)) {
		client.smartPublish(topicPrefix + 'pressure', parseResult('pressure', state.pressure), mqttOptions)
	}
}

const motionHandler = function(query, topicPrefix, state) {
	// Climate
	if (!_.isNil(state.lux)) {
		client.smartPublish(topicPrefix + 'lux', parseResult('lux', state.lux), mqttOptions)
	}
	if (!_.isNil(state.dark)) {
		client.smartPublish(topicPrefix + 'dark', parseResult('dark', state.dark), mqttOptions)
	}
	if (!_.isNil(state.daylight)) {
		client.smartPublish(topicPrefix + 'daylight', parseResult('daylight', state.daylight), mqttOptions)
	}
	if (!_.isNil(state.lightlevel)) {
		client.smartPublish(topicPrefix + 'lightlevel', parseResult('lightlevel', state.lightlevel), mqttOptions)
	}
	if (!_.isNil(state.presence)) {
		client.smartPublish(topicPrefix + 'presence', parseResult('presence', state.presence), mqttOptions)
	}
}

const lightHandler = function(query, topicPrefix, state) {
	// Lights/Switches
	if (!_.isNil(state.bri)) {
		client.smartPublish(topicPrefix + 'brightness', parseResult('light', state.bri), mqttOptions)
		client.smartPublish(topicPrefix + 'state', parseResult('light', state.bri > 0 ? 1 : 0 ), mqttOptions)
	}
	if (!_.isNil(state.on)) {
		client.smartPublish(topicPrefix + 'state', parseResult('on', state.on ), mqttOptions)
	}

	if (!_.isNil(state.effect)) {
		client.smartPublish(topicPrefix + 'effect', parseResult('effect', state.effect ), mqttOptions)
	}

	if (!_.isNil(state.sat)) {
		client.smartPublish(topicPrefix + 'sat', parseResult('sat', state.sat ), mqttOptions)
	}

	if (!_.isNil(state.xy)) {
		client.smartPublish(topicPrefix + 'xy', parseResult('xy', state.xy ), mqttOptions)
	}

	if (!_.isNil(state.hue)) {
		client.smartPublish(topicPrefix + 'hue', parseResult('hue', state.hue ), mqttOptions)
	}

	if (!_.isNil(state.alert)) {
		client.smartPublish(topicPrefix + 'alert', parseResult('alert', state.alert ), mqttOptions)
	}

	if (!_.isNil(state.ct)) {
		client.smartPublish(topicPrefix + 'ct', parseResult('ct', state.ct ), mqttOptions)
	}
}

const handleUpdateEvent = function(query, json) {
	if (_.isNil(json) ) {
		logging.error('Empty update event')
		return
	}
  
	const deviceType = json.r

	if ( _.isNil(deviceType)) {
		logging.error('Empty device type from JSON: ' + JSON.stringify(json))
		return
	}
  
	if ( deviceType == 'sensors' && json.modelid == 'PHDL00' && json.manufacturername == 'Philips' ) { 
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

	// Filter out the built in 'daylight' sensor

	if ( !_.isNil(json.state)) {

		climateHandler(query, topicPrefix, json.state)
		motionHandler(query, topicPrefix, json.state)  
		lightHandler(query, topicPrefix, json.state)
    
		if (!_.isNil(json.state.buttonevent) && !query) {
			client.smartPublish(topicPrefix + 'buttonevent', parseResult('buttonevent', json.state.buttonevent))
		}
  
		// Contact
		if (!_.isNil(json.state.open)) {
			client.smartPublish(topicPrefix + 'contact', parseResult('contact', json.state.open), mqttOptions)
		}

		// Water
		if (!_.isNil(json.state.water)) {
			client.smartPublish(topicPrefix + 'water', parseResult('water', json.state.water), mqttOptions)
		}

		// Contact
		if (!_.isNil(json.state.lastupdated)) {
			client.smartPublish(topicPrefix + 'lastupdated', parseResult('date', json.state.lastupdated), mqttOptions)
			var now = moment(new Date()).tz(TIMEZONE)
			var dayAgo = moment(now).subtract(4, 'hours')      
			var lastUpdatedDate = moment(new Date(json.state.lastupdated + 'Z')).tz(TIMEZONE)

			if ( lastUpdatedDate < dayAgo ) {
				client.smartPublish(topicPrefix + 'reachable', parseResult('reachable', '0'), mqttOptions)
			} else {
				client.smartPublish(topicPrefix + 'reachable', parseResult('reachable', '1'), mqttOptions)
			}
		}
	}

	if ( !_.isNil(json.config)) {
		logging.info('Config: ' + JSON.stringify(json))

		// Battery / Reachable
		if (!_.isNil(json.config.battery)) {
			client.smartPublish(topicPrefix + 'battery', parseResult('battery', json.config.battery), mqttOptions)
		}
    
		// See above, doing this with last updated date
		// if (!_.isNil(json.config.reachable)) {
		//   client.smartPublish(topicPrefix + 'reachable', parseResult('reachable', json.config.reachable), mqttOptions)
		// }

		if (!_.isNil(json.config.on)) {
			client.smartPublish(topicPrefix + 'state', parseResult('on', json.config.on ), mqttOptions)
		}

		// Climate
		if (!_.isNil(json.config.temperature)) {
			client.smartPublish(topicPrefix + 'temperature', parseResult('temperature', json.config.temperature), mqttOptions)
		}
	}
}
