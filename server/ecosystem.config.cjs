'use strict';

const path = require('node:path');

module.exports = {
  apps: [{
    name: 'eddy-server',
    script: path.join(__dirname, 'server.js'),
    cwd: __dirname,
    autorestart: true,
    restart_delay: 3000,
    kill_timeout: 6500,
    env: { PORT: '3000' }
  }]
};
