'use strict';

const log = require('../logger');

class BasicLed {
  constructor(name) {
    this.name = name;
    this._current = null;
  }
  on() { this._current = 'on'; log.debug('led', `[noop] ${this.name} on`); }
  off() { this._current = 'off'; log.debug('led', `[noop] ${this.name} off`); }
  blink() { this._current = 'blink'; log.debug('led', `[noop] ${this.name} blink`); }
  destroy() { this._current = 'off'; log.debug('led', `[noop] ${this.name} destroy`); }
}

class StatusLed {
  setSetup() { log.debug('led', '[noop] status setup'); }
  setApps() { log.debug('led', '[noop] status apps'); }
  off() { log.debug('led', '[noop] status off'); }
}

class Display {
  showAP() { log.debug('display', '[noop] AP'); }
  showConn() { log.debug('display', '[noop] Conn'); }
  showErr0() { log.debug('display', '[noop] Err0'); }
  showTime() { log.debug('display', '[noop] time'); }
  showPin(pin) { log.debug('display', `[noop] PIN ${pin}`); }
}

class LanLed {
  start() { log.debug('led', '[noop] LAN start ignored'); }
  stop() { log.debug('led', '[noop] LAN stop ignored'); }
}

const led = new BasicLed('wifi');
led.bt = new BasicLed('bt');
led.status = new StatusLed();
led.display = new Display();
led.lan = new LanLed();

module.exports = led;
