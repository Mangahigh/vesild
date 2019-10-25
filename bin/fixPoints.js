#!/usr/bin/env node

const argv = require('minimist')(process.argv.slice(2));
const fs = require("fs");
const VesilD = require('../lib/index.js');

let config;

if (argv.config) {
  config = JSON.parse(argv.config);
} else if (argv['config-file']) {
  config = JSON.parse(fs.readFileSync(argv['config-file']));
}

(new VesilD(config))
    .fixPoints()
    .then(() => {
    console.log('Done!');
    process.exit(0);
});