# mqtt-deconz-bridge

This is a simple docker container that I use to bridge Deconz with my MQTT bridge.

I have a collection of bridges, and the general format of these begins with these environment variables:
```
      TOPIC_PREFIX: /your_topic_prefix  (eg: /some_topic_prefix/somthing)
      MQTT_HOST: YOUR_MQTT_URL (eg: mqtt://mqtt.yourdomain.net)
      (OPTIONAL) MQTT_USER: YOUR_MQTT_USERNAME
      (OPTIONAL) MQTT_PASS: YOUR_MQTT_PASSWORD
````

This will publish and (optionally) subscribe to events for this bridge with the TOPIC_PREFIX of you choosing.

Generally I use 0 as 'off', and 1 as 'on' for these.

For changing states '/set' commands also work, eg:

publish this to set "short_strip" light brightness to 50:
```
   topic: /deconz/lights/short_strip/brightness/set 
   value: 50
```

Here's an example docker compose:

```
version: '3.3'
services:
  mqtt-deconz-bridge:
    image: terafin/mqtt-deconz-bridge:latest
    environment:
      HEALTH_CHECK_PORT: "3001"
      LOGGING_NAME: mqtt-deconz-bridge
      HEALTH_CHECK_URL: /healthcheck
      HEALTH_CHECK_TIME: "120"
      TZ: America/Los_Angeles
      TOPIC_PREFIX: /your_topic_prefix  (eg: /deconz)
      DECONZ_IP: YOUR_DECONZ_IP
      DECONZ_PORT: "443"
      MQTT_HOST: YOUR_MQTT_URL (eg: mqtt://mqtt.yourdomain.net)
      (OPTIONAL) MQTT_USER: YOUR_MQTT_USERNAME
      (OPTIONAL) MQTT_PASS: YOUR_MQTT_PASSWORD
```

Here's an example publish for some of my cameras:


```
/deconz/sensors/living_room_climate/pressure 1003
/deconz/sensors/living_room_climate/humidity 49.99
/deconz/sensors/living_room_climate/temperature 19.72
/deconz/sensors/living_room_climate/reachable 1
/deconz/sensors/living_room_climate/battery 25
/deconz/sensors/living_room_climate/lastupdated 2019-12-02T01:42:34
/deconz/sensors/living_room_climate/state 1
/deconz/sensors/study_climate/pressure 1003
/deconz/sensors/study_climate/humidity 63.12
/deconz/sensors/study_climate/temperature 15.24
/deconz/sensors/study_climate/reachable 1
/deconz/sensors/study_climate/battery 65
/deconz/sensors/study_climate/lastupdated 2019-12-02T01:42:21
/deconz/sensors/study_climate/state 1
```
