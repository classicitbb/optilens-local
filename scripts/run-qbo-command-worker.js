'use strict';
const { runOnce } = require('../lib/qbo-command-worker');
runOnce().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
