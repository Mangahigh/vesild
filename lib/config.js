const syslog = require('syslog');
const merge = require('lodash.merge');

const defaultConfig = {
  /**
   * The port that VesilD will listen on
   *
   */
  port: 12345,

  /**
   * The host that VesilD will listen on
   * "undefined" means that VesilD will accept incoming connections from all hosts
   */
  host: undefined,

  /**
   * Connection options for the redis database
   */
  redis: {
    host: '127.0.0.1',
    port: 6379,
    namespace: 'vesil'
  },

  /**
   * The type of logging
   * Options are:
   *  - syslog:   Log to Syslog (127.0.0.1:514)
   *  - console:  Log to console
   *  - combined: Log to both syslog and console
   *  - false:    Disable logging
   */
  log: 'console',

  /**
   * A flag to indicate which logs we want (uses bitwise logic)
   * e.g
   * - 1 (error)
   * - 3 (error, warn)
   * - 7 (error, warn, log)
   * - 15 (error, warn, log, info)
   */
  logLevel: 7,

  /**
   * Is prometheus enabled
   * This will use extra resources! Only enable it if you are using it!
   */
  prometheusEnabled: false
};

module.exports = {
  getConfig:(config) => merge(defaultConfig, config || {})
};
