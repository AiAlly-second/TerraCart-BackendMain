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
      instances: process.env.PM2_INSTANCES || 'max', // Scale with CPU cores by default
      exec_mode: process.env.PM2_EXEC_MODE || 'cluster',
      watch: false, // Set to true for development
      max_memory_restart: process.env.PM2_MAX_MEMORY || '700M',
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
    },
  ],
};



























