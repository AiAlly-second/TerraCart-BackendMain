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
      script: './server.js',
      cwd: './backend',
      instances: 1, // Use 1 for single instance, or 'max' for cluster mode
      exec_mode: 'fork', // Use 'fork' for single instance, 'cluster' for cluster mode
      watch: false, // Set to true for development
      max_memory_restart: '500M', // Restart if memory exceeds 500MB
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










