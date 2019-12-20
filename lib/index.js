const configLib = require('./config');
const Logger = require('./logger');
const Redis = require('./redis');
const pathToRegexp = require('path-to-regexp');
const express = require('express');
const GracefulShutdownManager = require('@moebius/http-graceful-shutdown').GracefulShutdownManager;
const asyncForEach = require('./asyncForEach');
const forEach = require('./forEach');
const app = express();

const prmthClient = require('prom-client');
const prmthRegister = prmthClient.register;
const prmthCollectDefaultMetrics = prmthClient.collectDefaultMetrics;

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

        if (this._config.prometheusEnabled) {
            prmthCollectDefaultMetrics({timeout: 5000});
        }
    }

    static _createResponse(memberKey, leaderboardKey, points, rank) {
        return {
            'member': memberKey,
            'leaderboard': leaderboardKey,
            'points': parseFloat(points),
            'rank': rank === null ? null : (rank + 1)
        }
    }

    _generateKey(type, member) {
        /**
         * There are 3 stores in the redis database
         *
         * Leadearboard:
         *  - A redis sorted set
         *  - This contains the actual leaderboard as a scored list
         *  - The key for each item is the member key
         *  - The value is the score the members has
         *  - This allows quick searching of members and scores, and initial ranking
         *  - However members with the same scores will have different ranks
         *
         *  Ranks:
         *  - A redis sorted set
         *  - Store the unique scores in the leaderboard
         *  - Enables a true ranking to be made with duplicate scores having duplicate ranks
         *
         *  Member
         *  - A redis set
         *  - Allows quick lookup of all the leaderboards a member is part of
         */
        if (['leaderboard', 'ranks', 'member'].indexOf(type) === -1) {
            throw new Error(`Unknown key type: ${type}`);
        }

        let key =  `${this._config.redis.namespace}.${type}`;

        if (member) {
            key += `.${member}`;
        }

        return key;
    }

    _extractMember(key, type) {
        return key.replace(`${this._config.redis.namespace}.${type}.`, '')
    }

    async _incrementPoints(redisClient, leaderboardKey, memberKey, points) {
        const newPoints = await redisClient.zincrby(
            this._generateKey('leaderboard', leaderboardKey),
            points,
            memberKey
        );

        return {
            points: newPoints,
            prevPoints: newPoints - points
        };
    }

    async _setPoints(redisClient, leaderboardKey, memberKey, points) {
        const leaderboardRedisKey = this._generateKey('leaderboard', leaderboardKey);

        const prevPoints = parseFloat(await redisClient.zscore(leaderboardRedisKey, memberKey));

        await redisClient.zadd(
            leaderboardRedisKey,
            points,
            memberKey
        );

        return {
            points: points,
            prevPoints: prevPoints
        };
    }

    async _removePreviousRank(redisClient, leaderboardRedisKey, ranksRedisKey, points) {
        let removedPoints = false;
        if (points) {
            let success = null;
            redisClient.watch(ranksRedisKey);
            while (!success) {
                const numberOfPrev = parseInt(await redisClient.zcount(leaderboardRedisKey, points, points));

                if (numberOfPrev === 0) {
                    removedPoints = true;
                    success = await redisClient
                      .multi()
                      .zrem(ranksRedisKey, points)
                      .exec();

                    if (!success) {
                        this._logger.info('Concurrency occurred');
                        redisClient.discard();
                        redisClient.watch(ranksRedisKey);
                    }
                } else {
                    success = true;
                    redisClient.unwatch();
                }
            }
        }

        return removedPoints;
    }

    async _updatePoints(redisClient, leaderboardKey, memberKey, patchData) {
        let method;
        const ranksRedisKey = this._generateKey('ranks', leaderboardKey);
        const leaderboardRedisKey = this._generateKey('leaderboard', leaderboardKey);
        const memberRedisKey = this._generateKey('member', memberKey);

        switch (patchData.action) {
            case 'increment':
                method = '_incrementPoints';
                break;
            case 'add':
                method = '_setPoints';
                break;
            default:
                throw new Error('Unknown action: ' . action);
        }

        const pointsData = await this[method](
            redisClient,
            leaderboardKey,
            memberKey,
            patchData.value
        );

        const points = pointsData.points;
        const prevPoints = pointsData.prevPoints;

        await redisClient.sadd(memberRedisKey, leaderboardKey);

        // we hopefully trigger the watch command
        await redisClient.touch(ranksRedisKey);
        await redisClient.zadd(ranksRedisKey, points, points);

        this._removePreviousRank(redisClient, leaderboardRedisKey, ranksRedisKey, points);
        this._removePreviousRank(redisClient, leaderboardRedisKey, ranksRedisKey, prevPoints);

        let rank;

        if (points) {
            rank = await redisClient.zrevrank(ranksRedisKey, points);
        } else {
            rank = null;
        }

        return VesilD._createResponse(
            memberKey,
            leaderboardKey,
            parseFloat(points),
            rank
        );
    }

    async fixPoints(redisClient) {
        redisClient = redisClient || await this._redisLib.connect();
        const leaderboardKeys = await redisClient.keys(`${this._generateKey('leaderboard')}.*`);

        if (leaderboardKeys) {
            await asyncForEach(leaderboardKeys, async (leaderboardKey) => {
                const leaderboardName = this._extractMember(leaderboardKey, 'leaderboard');
                const ranksRedisKey = this._generateKey('ranks', leaderboardName);
                const leaderboardRedisKey = this._generateKey('leaderboard', leaderboardName);

                const points = await redisClient.zrange(ranksRedisKey, 0, -1);

                await asyncForEach(points, async (points) => {
                    const removedPoints = await this._removePreviousRank(redisClient, leaderboardRedisKey, ranksRedisKey, points);

                    if (removedPoints) {
                        this._logger.log(`Removed invalid points ${points}`);
                    }
                });
            });
        }
    }

    async _runFixPointsLoop(redisClient) {
      await this.fixPoints(redisClient);

      setTimeout(() => {
          this._runFixPointsLoop(redisClient);
      }, (5 * 60 * 1000) + (Math.random() * 60 * 1000));
    }


    /**
     * Run the server
     * @returns {VesilD}
     */
    async runServer() {
        const redisClient = await this._redisLib.connect();
        const that = this;

        const leaderboardPath = '/leaderboard/:leaderboardKey([^/]+)';
        const memberPath = '/member/:memberKey([0-9a-zA-Z]+)';
        const statusPath = '/status';
        const metricsPath = '/metrics';


        // PATCH requests
        app.patch(leaderboardPath + memberPath, async (req, res) => {
            let results = [];

            await asyncForEach(req.body, async function (patchData) {
                const result = await that._updatePoints(
                    redisClient,
                    req.params.leaderboardKey,
                    req.params.memberKey,
                    patchData
                );

                results.push(result);
            });

            res.json(results);
        });

        app.delete(leaderboardPath + memberPath, async (req, res) => {
            const ranksRedisKey = this._generateKey('ranks', req.params.leaderboardKey);
            const leaderboardRedisKey = this._generateKey('leaderboard', req.params.leaderboardKey);
            const memberRedisKey = this._generateKey('member', req.params.memberKey);

            const points = await redisClient.zscore(
                leaderboardRedisKey,
                req.params.memberKey
            );

            await redisClient.zrem(leaderboardRedisKey, req.params.memberKey);
            await redisClient.srem(memberRedisKey, req.params.leaderboardKey);

            if (points) {
                await this._removePreviousRank(redisClient, leaderboardRedisKey, ranksRedisKey, points);
            }

            res.statusCode = 204;
            res.send(null);
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

                const result = await that._updatePoints(
                    redisClient,
                    req.params.leaderboardKey,
                    maps.memberKey,
                    patchData
                );

                results.push(result);
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

                const result = await that._updatePoints(
                    redisClient,
                    maps.leaderboardKey,
                    req.params.memberKey,
                    patchData
                );

                results.push(result);
            });

            res.json(results);
        });

        // GET /leaderboard/:leaderboardKey
        app.get(leaderboardPath, async (req, res) => {
            const ranksRedisKey = that._generateKey('ranks', req.params.leaderboardKey);

            var rawRedisScores = await redisClient.zrevrange(
                that._generateKey('leaderboard', req.params.leaderboardKey),
                (req.query.start !== undefined) ? req.query.start - 1 : 0,
                (req.query.end !== undefined) ? req.query.end - 1 : 9,
                'withscores'
            );

            var redisPairs = {},
                scorePairs = {},
                t = null,
                results = [],
                ranks = {},
                minScore = Infinity,
                includeMember = req.query.includeMember || null;

            forEach(rawRedisScores, function (item) {
                if (t) {
                    redisPairs[t] = parseFloat(item);
                    t = null;
                } else {
                    t = item;
                }
            });

            forEach(Object.keys(redisPairs), function (key) {
                const points = redisPairs[key];

                minScore = Math.min(minScore, points);

                if (!scorePairs[points]) {
                    scorePairs[points] = [];
                }

                if (includeMember === key && points) {
                    includeMember = null;
                }

                scorePairs[points].push(key);
            });

            delete(scorePairs[minScore]);

            if (minScore !== 0) {
                scorePairs[minScore] = await redisClient.zrangebyscore(
                    that._generateKey('leaderboard', req.params.leaderboardKey),
                    minScore,
                    minScore
                );
            }

            if (includeMember) {
                const memberScore = await redisClient.zscore(
                    that._generateKey('leaderboard', req.params.leaderboardKey),
                    includeMember
                );

                scorePairs[memberScore] = [includeMember];
            }

            await asyncForEach(Object.keys(scorePairs), async function (points) {
                await asyncForEach(scorePairs[points], async function (memberId) {
                    let rank = ranks[points];

                    if (!rank) {
                        rank = await redisClient.zrevrank(ranksRedisKey, points);
                        ranks[points] = rank;
                    }

                    results.push(
                        VesilD._createResponse(
                            memberId,
                            req.params.leaderboardKey,
                            points,
                            rank
                        )
                    );
                });
            });

            res.json(results.sort(function (a, b) {
                if (a.rank < b.rank) {
                    return -1;
                }
                if (a.rank > b.rank) {
                    return 1;
                }
                // a must be equal to b
                return 0;
            }));
        });

        // GET /member/:memberKey
        app.get(memberPath, async (req, res) => {
            const leaderboards = await redisClient.smembers(that._generateKey('member', req.params.memberKey));
            let results = [];

            await asyncForEach(leaderboards, async function (leaderboardKey) {
                const score = await redisClient.zscore(
                    that._generateKey('leaderboard', leaderboardKey),
                    req.params.memberKey
                );

                const rank = await redisClient.zrevrank(
                    that._generateKey('ranks', leaderboardKey),
                    score
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

        // STATUS
        app.get(statusPath, async (req, res) => {
            const used = process.memoryUsage().heapUsed / 1024 / 1024;
            const memoryUsage = Math.round(used * 100) / 100;

            let stats = {};

            stats.healthy = redisClient.connected;
            stats.memory = memoryUsage + ' MB';

            if (!stats.healthy) {
                res.status(503);
            }

            res.json(stats);
        });

        if (this._config.prometheusEnabled) {
            app.get(metricsPath, async (req, res) => {
                res.set('Content-Type', prmthRegister.contentType);
                res.end(prmthRegister.metrics());
            });
        }

        const server = app.listen(this._config.port, () => {
            this._logger.log(`Server running on port ${this._config.port}`);
        });

        const shutdownManager = new GracefulShutdownManager(server);

        const gracefulShutdown = () => {
            console.log('Server is gracefully terminating...');
            shutdownManager.terminate(() => {
                console.log('Server has gracefully terminated');
                process.exit(0);
            });
        };

        process.on('SIGHUP', gracefulShutdown);
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

        this._runFixPointsLoop(redisClient);

        return this;
    }
}

module.exports = VesilD;
