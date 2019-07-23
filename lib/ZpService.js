// homebridge-zp/lib/ZpAccessory.js
// Copyright © 2016-2019 Erik Baauw. All rights reserved.
//
// Homebridge plugin for Sonos ZonePlayer.

'use strict'

const he = require('he')
const homebridgeLib = require('homebridge-lib')
const ZpClient = require('./ZpClient')

const nInputSources = 20

class ZpService extends homebridgeLib.ServiceDelegate {
  constructor (zpAccessory, params) {
    super(zpAccessory, params)
    this.zpAccessory = zpAccessory
    this.zpClient = this.zpAccessory.zpClient
  }

  static get Sonos () { return Sonos }
  static get Speaker () { return Speaker }
  static get Led () { return Led }
  static get Alarm () { return Alarm }
  static get Tv () { return Tv }
}

class Sonos extends ZpService {
  constructor (zpAccessory, params = {}) {
    params.name = zpAccessory.platform.config.nameScheme.replace('%', zpAccessory.zpClient.zoneName)
    params.Service = zpAccessory.platform.config.SpeakerService
    params.subtype = 'group'
    super(zpAccessory, params)
    this.zpClient.on('event', (device, service, payload) => {
      try {
        const f = `handle${device}${service}Event`
        if (this[f] != null) {
          this.debug('%s event', service)
          // this.debug('%s event: %j', service, payload)
          this[f](payload)
        }
      } catch (error) {
        this.error(error)
      }
    })
    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      setter: async (value) => {
        try {
          if (value === this.values.on) {
            return
          }
          if (
            value &&
            this.values.currentTransportActions.includes('Play') &&
            this.values.currentTrack !== 'TV'
          ) {
            await this.zpAccessory.coordinator.zpClient.play()
          } else if (
            !value &&
            this.values.currentTransportActions.includes('Pause')
          ) {
            await this.zpAccessory.coordinator.zpClient.pause()
          } else if (
            !value &&
            this.values.currentTransportActions.includes('Stop')
          ) {
            await this.zpAccessory.coordinator.zpClient.stop()
          } else {
            setTimeout(() => {
              this.values.on = !value
            }, this.platform.config.resetTimeout)
          }
        } catch (error) {
          this.error(error)
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'volume',
      Characteristic: this.platform.config.VolumeCharacteristic,
      unit: '%',
      setter: async (value) => {
        try {
          await this.zpAccessory.coordinator.zpClient.setGroupVolume(value)
        } catch (error) {
          this.error(error)
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'changeVolume',
      Characteristic: this.Characteristics.my.ChangeVolume,
      value: 0,
      setter: async (value) => {
        try {
          await this.zpAccessory.coordinator.zpClient.setRelativeGroupVolume(value)
        } catch (error) {
          this.error(error)
        }
        setTimeout(() => {
          this.values.changeVolume = 0
        }, this.platform.config.resetTimeout)
      }
    })
    this.addCharacteristicDelegate({
      key: 'mute',
      Characteristic: this.Characteristics.hap.Mute,
      setter: async (value) => {
        try {
          await this.zpAccessory.coordinator.zpClient.setGroupMute(value)
        } catch (error) {
          this.error(error)
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'currentTrack',
      Characteristic: this.Characteristics.my.CurrentTrack
    })
    this.addCharacteristicDelegate({
      key: 'uri'
    })
    this.addCharacteristicDelegate({
      key: 'changeTrack',
      Characteristic: this.Characteristics.my.ChangeTrack,
      value: 0,
      setter: async (value) => {
        try {
          if (
            value > 0 &&
            this.values.currentTransportActions.includes('Next')
          ) {
            await this.zpAccessory.coordinator.zpClient.next()
          } else if (
            value < 0 &&
            this.values.currentTransportActions.includes('Previous')
          ) {
            await this.zpAccessory.coordinator.zpClient.previous()
          }
        } catch (error) {
          this.error(error)
        }
        setTimeout(() => {
          this.values.changeTrack = 0
        }, this.platform.config.resetTimeout)
      }
    })
    if (this.zpClient.tvIn) {
      this.addCharacteristicDelegate({
        key: 'tv',
        Characteristic: this.Characteristics.my.Tv
      })
    }
    this.addCharacteristicDelegate({
      key: 'sonosGroup',
      Characteristic: this.Characteristics.my.SonosGroup
    })
    this.addCharacteristicDelegate({
      key: 'sonosCoordinator',
      Characteristic: this.Characteristics.my.SonosCoordinator,
      value: false,
      setter: async (value) => {
        try {
          if (value) {
            this.zpAccessory.becomePlatformCoordinator()
          } else {
            if (this.zpAccessory.speakerService != null) {
              this.zpAccessory.speakerService.values.on = false
            }
            this.platform.coordinator = null
          }
        } catch (error) {
          this.error(error)
        }
      }
    })
    this.emit('initialised')

    zpAccessory.once('groupInitialised', () => {
      this.zpClient.subscribe('/MediaRenderer/AVTransport/Event')
        .catch((error) => {
          this.error(error)
        })
      this.zpClient.subscribe('/MediaRenderer/GroupRenderingControl/Event')
        .catch((error) => {
          this.error(error)
        })
    })
  }

  handleMediaRendererAVTransportEvent (payload) {
    if (
      payload.lastChange == null ||
      !Array.isArray(payload.lastChange) ||
      payload.lastChange[0] == null
    ) {
      return
    }
    const event = payload.lastChange[0]
    let on
    let tv
    let track
    let currentTransportActions
    const state = event.transportState
    if (state != null && this.values.currentTrack !== 'TV') {
      if (state === 'PLAYING') {
        on = true
      } else if (state === 'PAUSED_PLAYBACK' || state === 'STOPPED') {
        on = false
      }
    }
    const meta = event.currentTrackMetaData
    // this.debug('currentTrackMetaData: %j', meta)
    if (meta != null && meta.res != null) {
      switch (meta.res._.split(':')[0]) {
        case 'x-rincon-stream': // Line in input.
          track = meta.title
          break
        case 'x-sonos-htastream': // SPDIF TV input.
          track = 'TV'
          on = meta.streamInfo !== 0 // 0: no input; 2: stereo; 18: Dolby 5.1; 22: ?
          tv = on
          break
        case 'x-sonosapi-vli': // Airplay2.
          track = 'Airplay2'
          break
        case 'aac': // Radio stream (e.g. DI.fm)
        case 'x-sonosapi-stream': // Radio stream.
        case 'x-rincon-mp3radio': // AirTunes (by homebridge-zp).
          track = meta.streamContent // info
          if (track === '') {
            if (event.enqueuedTransportUriMetaData != null) {
              track = event.enqueuedTransportUriMetaData.title // station
            }
          }
          break
        case 'x-file-cifs': // Library song.
        case 'x-sonos-http': // See issue #44.
        case 'http': // Song on iDevice.
        case 'https': // Apple Music, see issue #68
        case 'x-sonos-spotify': // Spotify song.
          if (meta.title != null) {
            track = meta.title // song
          }
          break
        case 'x-sonosapi-hls': // ??
        case 'x-sonosapi-hls-static': // e.g. Amazon Music
          // Skip! update will arrive in subsequent CurrentTrackMetaData events
          // and will be handled by default case
          break
        case 'x-rincon-buzzer':
          track = 'Sonos Chime'
          break
        default:
          if (meta.title != null) {
            track = meta.title // song
          } else {
            track = ''
          }
          break
      }
    }
    if (
      event.enqueuedTransportUri != null && event.enqueuedTransportUri !== ''
    ) {
      this.values.uri = he.escape(event.enqueuedTransportUri)
      for (const member of this.zpAccessory.members()) {
        member.sonosService.values.uri = this.values.uri
      }
    }
    if (
      event.currentTransportActions != null && this.values.currentTrack !== 'TV'
    ) {
      currentTransportActions = event.currentTransportActions.split(', ')
      if (currentTransportActions.length === 1) {
        track = ''
      }
    }
    if (on != null) {
      this.values.on = on
      for (const member of this.zpAccessory.members()) {
        member.sonosService.values.on = this.values.on
      }
    }
    if (
      track != null &&
      track !== 'ZPSTR_CONNECTING' && track !== 'ZPSTR_BUFFERING'
    ) {
      this.values.currentTrack = track
      for (const member of this.zpAccessory.members()) {
        member.sonosService.values.currentTrack = this.values.currentTrack
      }
    }
    if (tv != null) {
      if (tv !== this.values.tv) {
        if (tv || this.values.tv == null) {
          this.values.tv = tv
        } else {
          this.tvTimer = setTimeout(() => {
            this.tvTimer = null
            this.values.tv = tv
          }, 10000)
        }
      } else if (this.tvTimer != null) {
        clearTimeout(this.tvTimer)
        this.tvTimer = null
      }
    }
    if (currentTransportActions != null) {
      this.values.currentTransportActions = currentTransportActions
      for (const member of this.zpAccessory.members()) {
        member.sonosService.values.currentTransportActions =
          this.values.currentTransportActions
      }
    }
  }

  handleMediaRendererGroupRenderingControlEvent (event) {
    if (event.groupVolumeChangeable === 1) {
      this.zpAccessory.coordinator = this.zpAccessory
      this.zpAccessory.leaving = false
    }
    if (event.groupVolume != null) {
      this.values.volume = event.groupVolume
      for (const member of this.zpAccessory.members()) {
        member.sonosService.values.volume = this.values.volume
      }
    }
    if (event.groupMute != null) {
      this.values.mute = !!event.groupMute
      for (const member of this.zpAccessory.members()) {
        member.sonosService.values.mute = this.values.mute
      }
    }
  }
}

class Speaker extends ZpService {
  constructor (zpAccessory, params = {}) {
    params.name = zpAccessory.zpClient.zoneName + ' Speakers'
    params.Service = zpAccessory.platform.config.SpeakerService
    params.subtype = 'zone'
    super(zpAccessory, params)
    this.zpClient.on('event', (device, service, payload) => {
      try {
        const f = `handle${device}${service}Event`
        if (this[f] != null) {
          this.debug('%s event', service)
          // this.debug('%s event: %j', service, payload)
          this[f](payload)
        }
      } catch (error) {
        this.error(error)
      }
    })
    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      setter: async (value) => {
        try {
          if (value === this.values.on) {
            return
          }
          this.values.on = value
          if (value) {
            const coordinator = this.platform.coordinator
            if (coordinator) {
              return this.zpClient.setAvTransportGroup(coordinator.zpClient.id)
            }
            return this.zpAccessory.becomePlatformCoordinator()
          }
          if (this.platform.coordinator === this.zpAccessory) {
            this.platform.coordinator = null
          }
          if (this.isCoordinator) {
            const newCoordinator = this.zpAccessory.members()[0]
            if (newCoordinator != null) {
              newCoordinator.becomePlatformCoordinator()
              this.zpAccessory.leaving = true
              return this.zpClient.delegateGroupCoordinationTo(
                newCoordinator.zpClient.id
              )
            }
          }
          this.zpAccessory.leaving = true
          return this.zpClient.becomeCoordinatorOfStandaloneGroup()
        } catch (error) {
          this.error(error)
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'volume',
      Characteristic: this.platform.config.VolumeCharacteristic,
      unit: '%',
      setter: this.zpClient.setVolume.bind(this.zpClient)
    })
    this.addCharacteristicDelegate({
      key: 'changeVolume',
      Characteristic: this.Characteristics.my.ChangeVolume,
      value: 0,
      setter: async (value) => {
        try {
          await this.zpClient.setRelativeVolume(value)
        } catch (error) {
          this.error(error)
        }
        setTimeout(() => {
          this.values.changeVolume = 0
        }, this.platform.config.resetTimeout)
      }
    })
    this.addCharacteristicDelegate({
      key: 'mute',
      Characteristic: this.Characteristics.hap.Mute,
      setter: this.zpClient.setMute.bind(this.zpClient)
    })
    this.addCharacteristicDelegate({
      key: 'loudness',
      Characteristic: this.Characteristics.my.Loudness,
      setter: this.zpClient.setLoudness.bind(this.zpClient)
    })
    this.addCharacteristicDelegate({
      key: 'bass',
      Characteristic: this.Characteristics.my.Bass,
      setter: this.zpClient.setBass.bind(this.zpClient)
    })
    this.addCharacteristicDelegate({
      key: 'treble',
      Characteristic: this.Characteristics.my.Treble,
      setter: this.zpClient.setTreble.bind(this.zpClient)
    })
    if (this.zpClient.balance) {
      this.addCharacteristicDelegate({
        key: 'balance',
        Characteristic: this.Characteristics.my.Balance,
        unit: '%',
        setter: this.zpClient.setBalance.bind(this.zpClient)
      })
    }
    if (this.zpClient.tvIn) {
      this.addCharacteristicDelegate({
        key: 'nightSound',
        Characteristic: this.Characteristics.my.NightSound,
        setter: this.zpClient.setNightSound.bind(this.zpClient)
      })
      this.addCharacteristicDelegate({
        key: 'speechEnhancement',
        Characteristic: this.Characteristics.my.SpeechEnhancement,
        setter: this.zpClient.setSpeechEnhancement.bind(this.zpClient)
      })
    }
    this.emit('initialised')
    this.zpClient.subscribe('/MediaRenderer/RenderingControl/Event')
      .catch((error) => {
        this.error(error)
      })
  }

  handleMediaRendererRenderingControlEvent (payload) {
    if (
      payload.lastChange == null ||
      !Array.isArray(payload.lastChange) ||
      payload.lastChange[0] == null
    ) {
      return
    }
    const event = payload.lastChange[0]
    if (event.volume != null && event.volume.master != null) {
      this.values.volume = event.volume.master
      if (
        this.zpClient.balance &&
        event.volume.lf != null && event.volume.rf != null
      ) {
        this.values.balance = event.volume.rf - event.volume.lf
      }
    }
    if (event.mute != null && event.mute.master != null) {
      this.values.mute = !!event.mute.master
    }
    if (event.loudness != null && event.loudness.master != null) {
      this.values.loudness = !!event.loudness.master
    }
    if (event.bass != null) {
      this.values.bass = event.bass
    }
    if (event.treble != null) {
      this.values.treble = event.treble
    }
    if (event.nightMode != null) {
      this.values.nightSound = !!event.nightMode
    }
    if (event.dialogLevel != null) {
      this.values.speechEnhancement = !!event.dialogLevel
    }
  }
}

class Led extends ZpService {
  constructor (zpAccessory, zpClient) {
    const params = {
      name: zpClient.zoneName + ' Sonos LED',
      Service: zpAccessory.Services.hap.Lightbulb,
      subtype: 'led' + (zpClient.channel == null ? '' : zpClient.channel)
    }
    if (zpClient.role !== 'master') {
      params.name += ' (' + zpClient.channel + ')'
    }
    super(zpAccessory, params)
    const paramsOn = {
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      setter: this.zpClient.setLedState.bind(this.zpClient)
    }
    const paramsLocked = {
      key: 'locked',
      Characteristic: this.Characteristics.hap.LockPhysicalControls,
      setter: this.zpClient.setButtonLockState.bind(this.zpClient)
    }
    if (!(this.platform.config.heartrate > 0)) {
      paramsOn.getter = this.zpClient.getLedState.bind(this.zpClient)
      paramsLocked.getter = async (value) => {
        return (await this.zpClient.getButtonLockState())
          ? this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_DISABLED
      }
    }
    this.addCharacteristicDelegate(paramsOn)
    this.addCharacteristicDelegate(paramsLocked)
    if (this.platform.config.heartrate > 0) {
      this.zpAccessory.on('heartbeat', async (beat) => {
        try {
          if (beat % this.platform.config.heartrate === 0) {
            if (!this.zpAccessory.blinking) {
              this.values.on = await this.zpClient.getLedState()
            }
            this.values.locked = (await this.zpClient.getButtonLockState())
              ? this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_ENABLED
              : this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_DISABLED
          }
        } catch (error) {
          this.error(error)
        }
      })
    }
    this.emit('initialised')
  }
}

class Alarm extends ZpService {
  constructor (zpAccessory, alarm) {
    const params = {
      id: alarm.id,
      name: zpAccessory.zpClient.zoneName + ' Sonos Alarm ' + alarm.id,
      Service: zpAccessory.Services.hap.Switch,
      subtype: 'alarm' + alarm.id
    }
    super(zpAccessory, params)
    this.addCharacteristicDelegate({
      key: 'on',
      Characteristic: this.Characteristics.hap.On,
      setter: async (value) => {
        const alarm = Object.assign({}, this._alarm)
        alarm.enabled = value ? 1 : 0
        return this.zpClient.updateAlarm(alarm)
      }
    })
    this.addCharacteristicDelegate({
      'key': 'currentTrack',
      Characteristic: this.Characteristics.my.CurrentTrack
    })
    this.addCharacteristicDelegate({
      'key': 'time',
      Characteristic: this.Characteristics.my.Time
    })
    this.emit('initialised')
    this.alarm = alarm
  }

  get alarm () { return this._alarm }
  set alarm (alarm) {
    this._alarm = alarm
    this.values.on = alarm.enabled === 1
    this.values.currentTrack = alarm.programUri === 'x-rincon-buzzer:0'
      ? 'Sonos Chime'
      : alarm.programMetaData != null && alarm.programMetaData.title != null
        ? alarm.programMetaData.title
        : 'unknown'
    this.values.time = alarm.startTime
  }
}

const remoteKeys = {}
const volumeSelectors = {}

function init (characteristicHap) {
  if (Object.keys(remoteKeys).length > 0) {
    return
  }
  remoteKeys[characteristicHap.RemoteKey.REWIND] = 'Rewind'
  remoteKeys[characteristicHap.RemoteKey.FAST_FORWARD] = 'Fast Forward'
  remoteKeys[characteristicHap.RemoteKey.NEXT_TRACK] = 'Next Track'
  remoteKeys[characteristicHap.RemoteKey.PREVIOUS_TRACK] = 'Previous Track'
  remoteKeys[characteristicHap.RemoteKey.ARROW_UP] = 'Up'
  remoteKeys[characteristicHap.RemoteKey.ARROW_DOWN] = 'Down'
  remoteKeys[characteristicHap.RemoteKey.ARROW_LEFT] = 'Left'
  remoteKeys[characteristicHap.RemoteKey.ARROW_RIGHT] = 'Right'
  remoteKeys[characteristicHap.RemoteKey.SELECT] = 'Select'
  remoteKeys[characteristicHap.RemoteKey.BACK] = 'Back'
  remoteKeys[characteristicHap.RemoteKey.EXIT] = 'Exit'
  remoteKeys[characteristicHap.RemoteKey.PLAY_PAUSE] = 'Play/Pause'
  remoteKeys[characteristicHap.RemoteKey.INFORMATION] = 'Info'
  volumeSelectors[characteristicHap.VolumeSelector.INCREMENT] = 'Up'
  volumeSelectors[characteristicHap.VolumeSelector.DECREMENT] = 'Down'
}

class Tv extends ZpService {
  constructor (zpAccessory, params = {}) {
    params.name = zpAccessory.zpClient.zoneName + ' TV'
    params.Service = zpAccessory.Services.hap.Television
    params.subtype = 'tv'
    params.primaryService = true
    super(zpAccessory, params)
    init(this.Characteristics.hap)
    this.zpClient.on('event', (device, service, payload) => {
      try {
        const f = `handle${device}${service}Event`
        if (this[f] != null) {
          this.debug('%s event', service)
          // this.debug('%s event: %j', service, payload)
          this[f](payload)
        }
      } catch (error) {
        this.error(error)
      }
    })

    // FIXME: _associatedHAPAccessory only initialised on publish
    // this.zpAccessory._accessory._associatedHAPAccessory.setPrimaryService(this._service)
    this.zpMaster = params.master
    this.sonosService = this.zpMaster.sonosService
    this.sonosValues = this.sonosService.values

    this.Speaker = new ZpService.Tv.Speaker(this.zpAccessory, params)

    // HomeKit doesn't like changes to service or characteristic properties,
    // so we create a static set of (disabled, hidden) InputSource services
    // to be configured later.
    this.sources = []
    this.inputSources = []
    this.displayOrder = []
    for (let identifier = 1; identifier <= nInputSources; identifier++) {
      const inputSource = new ZpService.Tv.InputSource(this.zpAccessory, {
        configuredName: 'Input ' + identifier,
        identifier: identifier
      })
      this.inputSources.push(inputSource)
      this._service.addLinkedService(inputSource._service) // FIXME
      this.displayOrder.push(0x01, 0x04, identifier & 0xff, 0x00, 0x00, 0x00)
    }
    this.displayOrder.push(0x00, 0x00)

    this.addCharacteristicDelegate({
      key: 'active',
      Characteristic: this.Characteristics.hap.Active,
      value: this.sonosValues.on
        ? this.Characteristics.hap.Active.ACTIVE
        : this.Characteristics.hap.Active.INACTIVE,
      setter: async (value) => {
        try {
          if (value === this.values.active) {
            return
          }
          if (
            value === this.Characteristics.hap.Active.ACTIVE &&
            this.sonosValues.currentTransportActions.includes('Play') &&
            this.sonosValues.currentTrack !== 'TV'
          ) {
            await this.zpMaster.coordinator.zpClient.play()
          } else if (
            value === this.Characteristics.hap.Active.INACTIVE &&
            this.sonosValues.currentTransportActions.includes('Pause')
          ) {
            await this.zpMaster.coordinator.zpClient.pause()
          } else if (
            value === this.Characteristics.hap.Active.INACTIVE &&
            this.sonosValues.currentTransportActions.includes('Stop')
          ) {
            await this.zpMaster.coordinator.zpClient.stop()
          } else {
            setTimeout(() => {
              this.values.active = 1 - value
            }, this.platform.config.resetTimeout)
          }
        } catch (error) {
          this.error(error)
        }
      }
    }).on('didSet', (value) => {
      this.sonosValues.on = value === this.Characteristics.hap.Active.ACTIVE
    })
    this.sonosService.characteristicDelegate('on').on('didSet', (value) => {
      this.values.active = value ? 1 : 0
    })
    const activeIdentifier = this.addCharacteristicDelegate({
      key: 'activeIdentifier',
      Characteristic: this.Characteristics.hap.ActiveIdentifier,
      props: { maxValue: nInputSources },
      // silent: true,
      setter: async (value) => {
        try {
          if (value < 1 || value > nInputSources) {
            return
          }
          const source = this.sources[value - 1]
          this.log(
            '%s: %s', activeIdentifier.displayName, source.configuredName
          )
          if (source.uri == null) {
            await this.zpClient.becomeCoordinatorOfStandaloneGroup()
            this.values.activeIdentifier = 0
          } else {
            await this.zpMaster.coordinator.zpClient.setAvTransportUri(
              source.uri, source.meta
            )
            await this.zpMaster.coordinator.zpClient.play()
          }
          setTimeout(() => {
            const identifier = this.activeIdentifier(this.sonosValues.uri)
            this.values.activeIdentifier = identifier
          }, this.platform.config.resetTimeout)
        } catch (error) {
          this.error(error)
        }
      }
    }).on('didSet', (value) => {
      if (value > 0) {
        const source = this.sources[value - 1]
        this.log('%s: %s', activeIdentifier.displayName, source.configuredName)
      }
    })
    this.sonosService.characteristicDelegate('uri')
      .on('didSet', (value) => {
        const identifier = this.activeIdentifier(this.sonosValues.uri)
        this.values.activeIdentifier = identifier
      })
    this.addCharacteristicDelegate({
      key: 'configuredName',
      Characteristic: this.Characteristics.hap.ConfiguredName,
      value: this.platform.config.nameScheme.replace('%', this.zpClient.zoneName)
    })
    this.addCharacteristicDelegate({
      key: 'sleepDiscoveryMode',
      Characteristic: this.Characteristics.hap.SleepDiscoveryMode,
      silent: true,
      value: this.Characteristics.hap.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
    })
    this.addCharacteristicDelegate({
      key: 'displayOrder',
      Characteristic: this.Characteristics.hap.DisplayOrder,
      silent: true,
      value: Buffer.from(this.displayOrder).toString('base64')
    })
    const remoteKey = this.addCharacteristicDelegate({
      key: 'remoteKey',
      Characteristic: this.Characteristics.hap.RemoteKey,
      silent: true,
      setter: async (value) => {
        this.log('%s: %s', remoteKey.displayName, remoteKeys[value])
        switch (value) {
          case this.Characteristics.hap.RemoteKey.PLAY_PAUSE:
            const value = 1 - this.values.active
            if (
              value === this.Characteristics.hap.Active.ACTIVE &&
              this.sonosValues.currentTransportActions.includes('Play') &&
              this.sonosValues.currentTrack !== 'TV'
            ) {
              return this.zpMaster.coordinator.zpClient.play()
            } else if (
              value === this.Characteristics.hap.Active.INACTIVE &&
              this.sonosValues.currentTransportActions.includes('Pause')
            ) {
              return this.zpMaster.coordinator.zpClient.pause()
            } else if (
              value === this.Characteristics.hap.Active.INACTIVE &&
              this.sonosValues.currentTransportActions.includes('Stop')
            ) {
              return this.zpMaster.coordinator.zpClient.stop()
            }
            break
          case this.Characteristics.hap.RemoteKey.ARROW_LEFT:
            if (this.sonosValues.currentTransportActions.includes('Previous')) {
              return this.zpMaster.coordinator.zpClient.previous()
            }
            break
          case this.Characteristics.hap.RemoteKey.ARROW_RIGHT:
            if (this.sonosValues.currentTransportActions.includes('Next')) {
              return this.zpMaster.coordinator.zpClient.next()
            }
            break
          default:
            break
        }
      }
    })
    this.addCharacteristicDelegate({
      key: 'powerModeSelection',
      Characteristic: this.Characteristics.hap.PowerModeSelection,
      silent: true
    })

    this.notYetInitialised = true
    this.zpClient.subscribe('/MediaServer/ContentDirectory/Event')
      .catch((error) => {
        this.error(error)
      })
  }

  activeIdentifier (uri) {
    for (let i = 0; i < this.sources.length; i++) {
      if (this.sources[i].uri === uri) {
        return i + 1
      }
    }
    return 0
  }

  async handleMediaServerContentDirectoryEvent (event) {
    if (
      event.favoritesUpdateId == null ||
      event.favoritesUpdateId === this.favoritesUpdateId
    ) {
      return
    }
    this.favoritesUpdateId = event.favoritesUpdateId
    this.sources = []
    this.visibleSources = []
    this.configureInputSource('Sonos Chime', 'x-rincon-buzzer:0')
    this.configureInputSource(
      'AirPlay', 'x-sonosapi-vli:' + this.zpClient.id, this.zpClient.airPlay
    )
    this.configureInputSource(
      'Audio In', 'x-rincon-stream:' + this.zpClient.id, this.zpClient.audioIn
    )
    this.configureInputSource(
      'TV', 'x-sonos-htastream:' + this.zpClient.id + ':spdif', this.zpClient.tvIn
    )
    this.configureInputSource(
      'Leave Group', undefined, this.zpClient.role === 'master'
    )
    for (const zoneName of Object.keys(this.platform.zones).sort()) {
      const zone = this.platform.zones[zoneName]
      this.configureInputSource(
        'Join ' + zoneName,
        'x-rincon:' + zone.zonePlayers[zone.master].id,
        zoneName !== this.zpClient.zoneName
      )
    }
    for (const fav of (await this.zpClient.browse('FV:2')).result) {
      if (fav.res != null && fav.res._ != null) {
        let meta
        if (fav.resMD != null /* && fav.description === 'TuneIn Station' */) {
          meta = ZpClient.meta(fav.resMD, fav.albumArtUri, fav.description)
        }
        this.configureInputSource(fav.title, he.escape(fav.res._), true, meta)
      }
    }
    for (let index = this.sources.length; index < nInputSources; index++) {
      const inputSource = this.inputSources[index]
      inputSource.values.configuredName = 'Input ' + index + 1
      inputSource.values.inputSourceType =
        this.Characteristics.hap.InputSourceType.TUNER
      inputSource.values.isConfigured =
        this.Characteristics.hap.IsConfigured.NOT_CONFIGURED
      inputSource.values.currentVisibilityState =
        this.Characteristics.hap.CurrentVisibilityState.HIDDEN
    }
    this.log('input sources: %j', this.visibleSources)
    if (this.notYetInitialised) {
      delete this.notYetInitialised
      this.emit('initialised')
    }
    this.values.activeIdentifier = this.activeIdentifier(this.sonosValues.uri)
  }

  configureInputSource (configuredName, uri, visible = true, meta) {
    this.sources.push({
      configuredName: configuredName,
      uri: uri,
      visible: visible,
      meta: meta
    })
    const identifier = this.sources.length
    if (identifier <= nInputSources) {
      const inputSource = this.inputSources[identifier - 1]
      inputSource.values.configuredName = configuredName
      inputSource.values.isConfigured = visible
        ? this.Characteristics.hap.IsConfigured.CONFIGURED
        : this.Characteristics.hap.IsConfigured.NOT_CONFIGURED
      inputSource.values.currentVisibilityState = visible
        ? this.Characteristics.hap.CurrentVisibilityState.SHOWN
        : this.Characteristics.hap.CurrentVisibilityState.HIDDEN
      if (configuredName === 'AirPlay') {
        inputSource.values.inputSourceType =
          this.Characteristics.hap.InputSourceType.OTHER
      } else if (configuredName === 'TV') {
        inputSource.values.inputSourceType =
          this.Characteristics.hap.InputSourceType.HDMI
      } else if (uri != null && uri.startsWith('x-sonosapi-stream:')) {
        inputSource.values.inputSourceType =
          this.Characteristics.hap.InputSourceType.TUNER
      }
      if (visible) {
        this.visibleSources.push(configuredName)
      }
    }
  }

  static get Speaker () { return TvSpeaker }
  static get InputSource () { return TvInputSource }
}

class TvSpeaker extends ZpService {
  constructor (zpAccessory, params = {}) {
    params.name = zpAccessory.zpClient.zoneName + ' TV Speaker'
    params.Service = zpAccessory.Services.hap.TelevisionSpeaker
    params.subtype = 'tvSpeaker'
    super(zpAccessory, params)
    this.addCharacteristicDelegate({
      key: 'volumeControlType',
      Characteristic: this.Characteristics.hap.VolumeControlType,
      silent: true,
      value: this.Characteristics.hap.VolumeControlType.ABSOLUTE
    })
    const volumeSelector = this.addCharacteristicDelegate({
      key: 'volumeSelector',
      Characteristic: this.Characteristics.hap.VolumeSelector,
      silent: true,
      setter: async (value) => {
        this.log('%s: %s', volumeSelector.displayName, volumeSelectors[value])
        return this.zpClient.setRelativeVolume(
          value === this.Characteristics.hap.VolumeSelector.INCREMENT ? 1 : -1
        )
      }
    })
    this.addCharacteristicDelegate({
      key: 'mute',
      Characteristic: this.Characteristics.hap.Mute,
      setter: this.zpClient.setMute.bind(this.zpClient)
    })
    this.emit('initialised')
  }
}

class TvInputSource extends ZpService {
  constructor (zpAccessory, params = {}) {
    params.name = zpAccessory.zpClient.zoneName + ' TV Input ' + params.identifier
    params.Service = zpAccessory.Services.hap.InputSource
    params.subtype = 'tvInput' + params.identifier
    super(zpAccessory, params)
    this.addCharacteristicDelegate({
      key: 'configuredName',
      Characteristic: this.Characteristics.hap.ConfiguredName,
      silent: true,
      value: params.configuredName
    })
    this.addCharacteristicDelegate({
      key: 'identifier',
      Characteristic: this.Characteristics.hap.Identifier,
      silent: true,
      value: params.identifier
    })
    this.addCharacteristicDelegate({
      key: 'inputSourceType',
      Characteristic: this.Characteristics.hap.InputSourceType,
      silent: true,
      value: this.Characteristics.hap.InputSourceType.OTHER
    })
    this.addCharacteristicDelegate({
      key: 'inputDeviceType',
      Characteristic: this.Characteristics.hap.InputDeviceType,
      silent: true,
      value: this.Characteristics.hap.InputDeviceType.AUDIO_SYSTEM
    })
    this.addCharacteristicDelegate({
      key: 'isConfigured',
      Characteristic: this.Characteristics.hap.IsConfigured,
      silent: true,
      value: this.Characteristics.hap.IsConfigured.NOT_CONFIGURED
    })
    this.addCharacteristicDelegate({
      key: 'currentVisibilityState',
      Characteristic: this.Characteristics.hap.CurrentVisibilityState,
      silent: true,
      value: this.Characteristics.hap.CurrentVisibilityState.HIDDEN
    })
    this.emit('initialised')
  }
}

module.exports = ZpService