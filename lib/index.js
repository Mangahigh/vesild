const configLib = require('./config');
const Logger = require('./logger');
const Redis = require('./redis');
const pathToRegexp = require('path-to-regexp');
const express = require('express');
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

    /**
     * Run the server
     * @returns {VesilD}
     */
    async runServer() {
        const redisClient = await this._redisLib.connect();

        const that = this;


        async function asyncForEach(array, callback) {
            for (let index = 0; index < array.length; index++) {
                await callback(array[index], index, array);
            }
        }

        app.listen(this._config.port, () => {
            this._logger.log('Server running on port ' + this._config.port);
        });

        // PATCH requests
        app.patch('/leaderboard/:leaderboardKey([0-9a-zA-Z\-\|]+)/member/:memberKey([0-9a-zA-Z]+)', async (req, res) => {
            let results = [];

            await asyncForEach(req.body, async function (data) {
                var value = await redisClient.zincrby(that._config.redis.namespace + '.leaderboard.' + req.params.leaderboardKey, data.value, req.params.memberKey);
                await redisClient.sadd(that._config.redis.namespace + '.member.' + req.params.memberKey, req.params.leaderboardKey);

                var rank = await redisClient.zrevrank(that._config.redis.namespace + '.leaderboard.' + req.params.leaderboardKey, req.params.memberKey);

                results.push({
                    'member': req.params.memberKey,
                    'leaderboard': req.params.leaderboardKey,
                    'points': parseFloat(value),
                    'rank': (rank + 1)
                });
            });

            res.json(results);
        });

        app.patch('/leaderboard/:leaderboardKey([0-9a-zA-Z\-\|]+)', async (req, res) => {
            const that = this;

            let results = [];

            await asyncForEach(req.body, async function (patchData) {
                const keys = [];

                var re = pathToRegexp('/member/:memberKey/points', keys);
                var values = re.exec(patchData.path);
                var maps = {};

                await asyncForEach(keys, function (key, index) {
                    maps[key['name']] = values[index+1];
                });

                var value = await redisClient.zincrby(that._config.redis.namespace + '.leaderboard.' + req.params.leaderboardKey, patchData.value, maps.memberKey);
                await redisClient.sadd(that._config.redis.namespace + '.member.' + maps.memberKey, req.params.leaderboardKey);

                var rank = await redisClient.zrevrank(that._config.redis.namespace + '.leaderboard.' + req.params.leaderboardKey, maps.memberKey);

                results.push({
                    'member': maps.memberKey,
                    'leaderboard': req.params.leaderboardKey,
                    'points': parseFloat(value),
                    'rank': (rank + 1)
                });
            });

            res.json(results);
        });

        app.patch('/member/:memberKey([0-9a-zA-Z]+)', async (req, res) => {
            const that = this;

            let results = [];

            await asyncForEach(req.body, async function (patchData) {
                const keys = [];

                var re = pathToRegexp('/leaderboard/:leaderboardKey/points', keys);
                var values = re.exec(patchData.path);
                var maps = {};

                await asyncForEach(keys, function (key, index) {
                    maps[key['name']] = values[index+1];
                });

                var value = await redisClient.zincrby(that._config.redis.namespace + '.leaderboard.' + maps.leaderboardKey, patchData.value, req.params.memberKey);
                await redisClient.sadd(that._config.redis.namespace + '.member.' + req.params.memberKey, maps.leaderboardKey);

                var rank = await redisClient.zrevrank(that._config.redis.namespace + '.leaderboard.' + maps.leaderboardKey, req.params.memberKey);

                results.push({
                    'member': req.params.memberKey,
                    'leaderboard': maps.leaderboardKey,
                    'points': parseFloat(value),
                    'rank': (rank + 1)
                });
            });

            res.json(results);
        });

        // GET requests
        app.get('/leaderboard/:leaderboardKey([0-9a-zA-Z\-\|]+)', async (req, res) => {
            var rank = 0;

            var results = await redisClient.zrevrange(this._config.redis.namespace + '.leaderboard.' + req.params.leaderboardKey, rank, 10, 'withscores');

            var r = {},
                t = null,
                data = [];

            await asyncForEach(results, async function (item) {
                if (t) {
                    r[t] = parseFloat(item);
                    t = null;
                } else {
                    t = item;
                }
            });

            await asyncForEach(Object.keys(r), async function (index) {
                data.push({
                    'member': index,
                    'leaderboard': req.params.leaderboardKey,
                    'points': r[index],
                    'rank': (rank + 1)
                });

                ++rank;
            });

            res.json(data);
        });

        app.get('/member/:memberKey([0-9a-zA-Z]+)', async (req, res) => {
            const that = this;

            var leaderboards = await redisClient.smembers(this._config.redis.namespace + '.member.' + req.params.memberKey);
            let data = [];

            await asyncForEach(leaderboards, async function (leaderboardKey) {
                var score = await redisClient.zscore(that._config.redis.namespace + '.leaderboard.' +leaderboardKey, req.params.memberKey);
                var rank = await redisClient.zrevrank(that._config.redis.namespace + '.leaderboard.' +leaderboardKey, req.params.memberKey);

                data.push({
                    'member': req.params.memberKey,
                    'leaderboard': leaderboardKey,
                    'points': parseFloat(score),
                    'rank': (rank + 1)
                });
            });

            res.json(data);
        });


        return this;
    }
}

module.exports = VesilD;
