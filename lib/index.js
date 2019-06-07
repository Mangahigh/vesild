const configLib = require('./config');
const Logger = require('./logger');
const Redis = require('./redis');
const pathToRegexp = require('path-to-regexp');
const express = require('express');
const asyncForEach = require('./asyncForEach');
const app = express();
app.use(express.json());

class VesilD {
    /**
     * @private
     * @param {Object} [config]
     */
    constructor(config) {
        /**
         * @private
         * @type {Object}
         */
        this._config = configLib.getConfig(config);

        /**
         * @type {Logger}
         * @private
         */
        this._logger = new Logger(this._config);

        /**
         * @type {Redis}
         * @private
         */
        this._redisLib = new Redis(this._config);

        // Catch all uncaughtExceptions to prevent the server stopping when a connection is unexpectedly closed
        process.on('uncaughtException', (err) => {
            this._logger.error(err.toString());
        });
    }

    static _createResponse(memberKey, leaderboardKey, points, rank) {
        return {
            'member': memberKey,
            'leaderboard': leaderboardKey,
            'points': parseFloat(points),
            'rank': (rank + 1)
        }
    }

    _generateKey(type, key) {
        if (['leaderboard', 'member'].indexOf(type) === -1) {
            throw new Error('Unknown type: ' . type);
        }

        return this._config.redis.namespace + '.' + type + '.' + key;
    }

    async _updatePoints(redisClient, leaderboardKey, memberKey, action, points) {
        let method;

        switch (action) {
            case 'increment':
                method = '_incrementPoints';
                break;
            case 'add':
                method = '_setPoints';
                break;
            default:
                throw new Error('Unknown action: ' . action);
        }

        return await this[method](redisClient, leaderboardKey, memberKey, points);
    }

    async _incrementPoints(redisClient, leaderboardKey, memberKey, points) {
        return await redisClient.zincrby(
            this._generateKey('leaderboard', leaderboardKey),
            points,
            memberKey
        );
    }

    async _setPoints(redisClient, leaderboardKey, memberKey, points) {
        return await redisClient.zadd(
            this._generateKey('leaderboard', leaderboardKey),
            points,
            memberKey
        );
    }

    /**
     * Run the server
     * @returns {VesilD}
     */
    async runServer() {
        const redisClient = await this._redisLib.connect();
        const that = this;

        const leaderboardPath = '/leaderboard/:leaderboardKey([0-9a-zA-Z\-\|_\+:]+)';
        const memberPath = '/member/:memberKey([0-9a-zA-Z]+)';
        const statusPath = '/status';

        app.listen(this._config.port, () => {
            this._logger.log('Server running on port ' + this._config.port);
        });

        // PATCH requests
        app.patch(leaderboardPath + memberPath, async (req, res) => {
            let results = [];

            await asyncForEach(req.body, async function (data) {
                const value = await that._updatePoints(
                    redisClient,
                    req.params.leaderboardKey,
                    req.params.memberKey,
                    data.action,
                    data.value
                );

                await redisClient.zincrby(
                    that._generateKey('leaderboard', req.params.leaderboardKey),
                    data.value,
                    req.params.memberKey
                );

                await redisClient.sadd(
                    that._generateKey('member', req.params.memberKey),
                    req.params.leaderboardKey
                );

                const rank = await redisClient.zrevrank(
                    that._generateKey('leaderboard', req.params.leaderboardKey),
                    req.params.memberKey
                );

                results.push(
                    VesilD._createResponse(
                        req.params.memberKey,
                        req.params.leaderboardKey,
                        parseFloat(value),
                        rank
                    )
                );
            });

            res.json(results);
        });

        app.patch(leaderboardPath, async (req, res) => {
            let results = [];

            await asyncForEach(req.body, async function (patchData) {
                const keys = [];
                const re = pathToRegexp(memberPath + '/points', keys);
                const values = re.exec(patchData.path);
                const maps = {};

                await asyncForEach(keys, function (key, index) {
                    maps[key['name']] = values[index+1];
                });

                const value = await that._updatePoints(
                    redisClient,
                    req.params.leaderboardKey,
                    maps.memberKey,
                    patchData.action,
                    patchData.value
                );

                await redisClient.sadd(
                    that._generateKey('member', maps.memberKey),
                    req.params.leaderboardKey
                );

                const rank = await redisClient.zrevrank(
                    that._generateKey('leaderboard', req.params.leaderboardKey),
                    maps.memberKey
                );

                results.push(
                    VesilD._createResponse(
                        maps.memberKey,
                        req.params.leaderboardKey,
                        parseFloat(value),
                        rank
                    )
                );
            });

            res.json(results);
        });

        app.patch(memberPath, async (req, res) => {
            let results = [];

            await asyncForEach(req.body, async function (patchData) {
                const keys = [];

                const re = pathToRegexp(leaderboardPath + '/points', keys);
                const values = re.exec(patchData.path);
                const maps = {};

                await asyncForEach(keys, function (key, index) {
                    maps[key['name']] = values[index+1];
                });

                const value = await that._updatePoints(
                    redisClient,
                    maps.leaderboardKey,
                    req.params.memberKey,
                    patchData.action,
                    patchData.value
                );

                await redisClient.sadd(
                    that._generateKey('member', req.params.memberKey),
                    maps.leaderboardKey
                );

                const rank = await redisClient.zrevrank(
                    that._generateKey('leaderboard', maps.leaderboardKey),
                    req.params.memberKey
                );

                results.push(
                    VesilD._createResponse(
                        req.params.memberKey,
                        req.params.leaderboardKey,
                        parseFloat(value),
                        rank
                    )
                );
            });

            res.json(results);
        });

        // GET requests
        app.get(leaderboardPath, async (req, res) => {
            let rank = 0;

            var data = await redisClient.zrevrange(
                that._generateKey('leaderboard', req.params.leaderboardKey),
                rank,
                10,
                'withscores'
            );

            var r = {},
                t = null,
                results = [];

            await asyncForEach(data, async function (item) {
                if (t) {
                    r[t] = parseFloat(item);
                    t = null;
                } else {
                    t = item;
                }
            });

            await asyncForEach(Object.keys(r), async function (index) {

                results.push(
                    VesilD._createResponse(
                        index,
                        req.params.leaderboardKey,
                        r[index],
                        rank
                    )
                );

                ++rank;
            });

            res.json(results);
        });

        app.get(memberPath, async (req, res) => {
            const leaderboards = await redisClient.smembers(that._generateKey('member', req.params.memberKey));
            let results = [];

            await asyncForEach(leaderboards, async function (leaderboardKey) {
                const score = await redisClient.zscore(
                    that._generateKey('leaderboard', leaderboardKey),
                    req.params.memberKey
                );

                const rank = await redisClient.zrevrank(
                    that._generateKey('leaderboard', leaderboardKey),
                    req.params.memberKey
                );

                results.push(
                    VesilD._createResponse(
                        req.params.memberKey,
                        leaderboardKey,
                        parseFloat(score),
                        rank
                    )
                );
            });

            res.json(results);
        });

        app.get(statusPath, async (req, res) => {
            const used = process.memoryUsage().heapUsed / 1024 / 1024;
            const memoryUsage = Math.round(used * 100) / 100;

            let stats = {};

            stats.healthy = redisClient.connected;
            stats.memory = memoryUsage + ' MB';

            res.json(stats);
        });


        return this;
    }
}

module.exports = VesilD;
