# AWS EC2 SSL Setup Guide for TerraCart

This guide explains how to fix the "Mixed Content" error (SSL) by setting up HTTPS on your backend using a custom domain, Nginx, and Let's Encrypt.

## 1. Domain & DNS Requirements

To have SSL (HTTPS), **you MUST own a domain name** (e.g., `myterracart.com`). You cannot easily get a trusted SSL certificate for a raw IP address.

### Recommended Subdomain Structure
We recommend creating **3 subdomains** in your domain provider's DNS settings (GoDaddy, Namecheap, Route53, etc.).

| Subdomain | Type | Value (Target) | Purpose |
|opt | --- | --- | --- |
| `api` | **A Record** | `YOUR_EC2_PUBLIC_IP` | Points to your Backend (e.g., `api.myterracart.com`) |
| `admin` | **CNAME** | `YOUR_CLOUDFRONT_URL` | Points to your Admin Panel |
| `app` (or `www`) | **CNAME** | `YOUR_CLOUDFRONT_URL` | Points to your Customer App |

**Step 1:** Go to your domain registrar and create an **A Record** for `api` pointing to your EC2 instance's Public IP address (e.g., `13.233.xx.xx`).

---

## 2. Install Nginx & Certbot on EC2

Login to your EC2 instance via SSH and run the following commands:

```bash
# 1. Update the server
sudo apt update

# 2. Install Nginx (Web Server) and Certbot (SSL Tool)
sudo apt install nginx certbot python3-certbot-nginx -y

# 3. Allow Nginx Traffic through Firewall
sudo ufw allow 'Nginx Full'
```

---

## 3. Configure Nginx Proxy

Set up Nginx to receive traffic on port 80/443 and forward it to your Node.js backend running on port 5001.

1. Create a new configuration file:
   ```bash
   sudo nano /etc/nginx/sites-available/terracart
   ```

2. Paste the following configuration (Replace `api.yourdomain.com` with your actual domain):
   ```nginx
   server {
       server_name api.yourdomain.com;

       location / {
           proxy_pass http://localhost:5001; # Forward to Node.js
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```
   *Press `Ctrl+X`, then `Y`, then `Enter` to save.*

3. Enable the configuration:
   ```bash
   # Link the config to sites-enabled
   sudo ln -s /etc/nginx/sites-available/terracart /etc/nginx/sites-enabled/

   # Remove the default config to avoid conflicts
   sudo rm /etc/nginx/sites-enabled/default

   # Test configuration for errors
   sudo nginx -t

   # Restart Nginx
   sudo systemctl restart nginx
   ```

---

## 4. Enable SSL (HTTPS)

Now that Nginx is running, generate the SSL certificate.

```bash
# Run Certbot (Follow the interactive prompts)
# Enter your email and agree to terms
sudo certbot --nginx -d api.yourdomain.com
```

**Success!** Your backend is now accessible at `https://api.yourdomain.com`.

---

## 5. Update Your Project Environment

Now that your backend is secure, update your local and production environment variables.

### In `frontend/.env` & `admin/.env`:
Change the backend URL to your new secure domain:
```env
VITE_API_URL=https://api.yourdomain.com
```
*Rebuild and redeploy your frontend applications to AWS S3/CloudFront.*

### In `backend/.env` (on EC2):
Update CORS to allow your properly hosted frontend domains:
```env
ALLOWED_ORIGINS=https://app.yourdomain.com,https://admin.yourdomain.com
```
*Restart your backend process (PM2) to apply changes (`pm2 restart all`).*
