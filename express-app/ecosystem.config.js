// PM2 process supervision for the two long-running Node processes this app
// needs kept alive: the API server and the no-show timer worker. Redis stays
// a separate Docker concern (see ../start-all.bat) — PM2 only supervises
// Node processes, not the container.
module.exports = {
  apps: [
    {
      name: 'jobfair-api',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10000,
      restart_delay: 1000,
      out_file: './logs/api-out.log',
      error_file: './logs/api-error.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'jobfair-noshow-worker',
      script: 'workers/noShowWorker.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10000,
      restart_delay: 1000,
      out_file: './logs/worker-out.log',
      error_file: './logs/worker-error.log',
      merge_logs: true,
      time: true
    }
  ]
};
