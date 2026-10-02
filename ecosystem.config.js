/**
 * PM2 Ecosystem Configuration for AWS EC2
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [
    {
      name: 'terra-cart-backend',
      // Use config file directory so PM2 works no matter where it is started from
      script: 'server.js',
      cwd: __dirname,
      // One process is the safe default for the observed t3.small/fork setup.
      // Horizontal scaling must be explicit and have a healthy socket adapter.
      instances: process.env.PM2_INSTANCES || 1,
      exec_mode: process.env.PM2_EXEC_MODE || 'fork',
      watch: false, // Set to true for development
      ...(process.env.PM2_MAX_MEMORY
        ? { max_memory_restart: process.env.PM2_MAX_MEMORY }
        : {}),
      env: {
        NODE_ENV: 'production',
        PORT: 5001,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5001,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true, // Add timestamp to logs
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      exp_backoff_restart_delay: 2000,
      kill_timeout: 15000,
    },
  ],
};


























