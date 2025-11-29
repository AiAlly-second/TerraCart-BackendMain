# Terra Cart Security Guide

This document outlines the security features implemented in the Terra Cart backend and provides a production checklist.

## 🔒 Security Features

### 1. Signed URLs for Protected Files

Sensitive documents (Aadhar, PAN, certificates) are now protected with signed URLs:

```javascript
// Files are accessed via signed URLs that expire
GET /api/files/secure/uploads/franchise-docs/file.pdf?expires=...&signature=...
```

**Features:**
- Time-based expiration (default: 60 minutes for documents)
- Cryptographic signature verification
- Timing-safe comparison to prevent timing attacks
- Directory traversal prevention

### 2. Rate Limiting

Protection against brute force and DDoS attacks:

| Route | Limit | Window |
|-------|-------|--------|
| General API | 500 requests | 15 minutes |
| Login | 10 attempts | 15 minutes |
| Password Reset | 5 attempts | 1 hour |
| File Upload | 50 uploads | 1 hour |
| Order Creation | 30 orders | 1 minute |

### 3. Security Headers

All responses include security headers:
- `X-Frame-Options: DENY` - Prevents clickjacking
- `X-Content-Type-Options: nosniff` - Prevents MIME sniffing
- `X-XSS-Protection: 1; mode=block` - XSS filter
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security` (in production with HTTPS)

### 4. Input Sanitization

All user inputs are sanitized to prevent:
- XSS (Cross-Site Scripting)
- HTML injection
- Deep nesting attacks

### 5. Input Validation

Routes now validate:
- Email format
- Password strength (minimum 6 characters)
- MongoDB ObjectId format
- Phone number format (Indian)
- GST number format
- Date of birth (minimum age 18)
- Order status values
- Price and quantity values

### 6. CORS Configuration

In production:
- Specific allowed origins (no wildcards)
- Credentials support
- Preflight caching (24 hours)

### 7. JWT Security

- Tokens expire after 30 days
- Fresh user data fetched on each request (catches deactivations)
- Specific error codes for different auth failures

### 8. Error Handling

- Production errors don't leak stack traces
- Generic error messages for auth failures (prevents user enumeration)
- Proper HTTP status codes

## 🚀 Production Checklist

Before deploying to production, ensure:

### Environment Variables

```env
# REQUIRED - Change these!
JWT_SECRET=<generate-64-byte-hex-string>
SIGNED_URL_SECRET=<different-secure-secret>
MONGO_URI=<production-mongodb-uri>

# REQUIRED - Set your domains
ALLOWED_ORIGINS=https://admin.yourdomain.com,https://app.yourdomain.com
API_BASE_URL=https://api.yourdomain.com

# REQUIRED - Enable production mode
NODE_ENV=production
ALLOW_PUBLIC_UPLOADS=false
```

### Generate Secure Secrets

```bash
# Generate JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Generate signed URL secret (use different secret!)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Security Checklist

- [ ] JWT_SECRET changed from default
- [ ] SIGNED_URL_SECRET set (different from JWT_SECRET)
- [ ] MONGO_URI points to production database
- [ ] ALLOWED_ORIGINS set to actual frontend domains
- [ ] NODE_ENV=production
- [ ] ALLOW_PUBLIC_UPLOADS=false
- [ ] SSL/TLS enabled (via reverse proxy like Nginx)
- [ ] Database has authentication enabled
- [ ] Database backups configured
- [ ] Monitoring/alerting set up
- [ ] Firewall configured (only needed ports open)
- [ ] Regular security updates scheduled

## 📁 File Structure

```
backend/
├── middleware/
│   ├── authMiddleware.js      # JWT authentication
│   ├── securityMiddleware.js  # Rate limiting, headers, sanitization
│   └── validationMiddleware.js # Input validation
├── routes/
│   └── fileRoutes.js          # Secure file serving
├── utils/
│   └── signedUrl.js           # Signed URL generation/validation
└── env.example.txt            # Environment template
```

## 🔧 Usage Examples

### Accessing Protected Documents

Documents now return signed URLs:

```javascript
// API response includes signed URLs
{
  "aadharCard": "/uploads/franchise-docs/...",
  "aadharCardUrl": "https://api.domain.com/api/files/secure/uploads/...",
  "aadharCardExpires": "2024-01-01T12:00:00.000Z"
}
```

Frontend should use `aadharCardUrl` for display.

### Handling Rate Limits

Responses include rate limit headers:

```
X-RateLimit-Limit: 500
X-RateLimit-Remaining: 495
X-RateLimit-Reset: 1704067200
```

When rate limited (429 status):
```json
{
  "success": false,
  "message": "Too many requests, please try again later",
  "retryAfter": 300
}
```

## 🛡️ Common Attack Mitigations

| Attack | Mitigation |
|--------|------------|
| SQL/NoSQL Injection | Input validation, parameterized queries |
| XSS | Input sanitization, Content-Type headers |
| CSRF | CORS configuration, SameSite cookies |
| Brute Force | Rate limiting on auth endpoints |
| DDoS | General rate limiting |
| Clickjacking | X-Frame-Options header |
| MITM | HTTPS enforcement, HSTS header |
| Path Traversal | Signed URLs, path validation |
| User Enumeration | Generic auth error messages |

## 📞 Security Contact

If you discover a security vulnerability, please report it responsibly.

---

*Last updated: November 2024*






