module.exports = {
  apps: [
    {
      name: 'meta-ads',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: '/var/www/meta-ads',
      instances: 2,           // 2 of 4 vCPUs; 2 left for PostgreSQL + Tracker
      exec_mode: 'cluster',   // Load balance requests across instances
      max_memory_restart: '2G',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,           // Tracker is on 3000, Add ERP on 3001
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      out_file: '/var/log/meta-ads-out.log',
      error_file: '/var/log/meta-ads-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
