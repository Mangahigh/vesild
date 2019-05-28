const Logger = require('./logger');
const redis = require('redis');
const asyncRedis = require("async-redis");

/**
 * Manages redis connections
 */
class Redis {
    /** @private */
    constructor(config) {
        /** @private */
        this._config = config;

        /** @private */
        this._logger = new Logger(config);
    }

    // ---

    async connect() {
        const client = await asyncRedis.createClient(this._config.redis);

        client.on('error', (err) => {
            this._logger.error('Redis error ' + err);
            throw err;
        });

        client.on('connect', () => {
            this._logger.info('Redis connected');
        });


        this._logger.info('Redis ready');
        return client;
    }
}

module.exports = Redis;
