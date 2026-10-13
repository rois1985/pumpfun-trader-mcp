// PM2 process file:  pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'pumpfun-mcp',
      script: 'dist/http.js',
      cwd: __dirname + '/..',
      node_args: '--env-file=.env',
      instances: 1, // MUST stay 1: state + websocket are in-process
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      kill_timeout: 5000,
      time: true,
    },
  ],
};
