# Deployment Guide

Options for deploying SignalZero LocalNode in production.

## Table of Contents

1. [Docker Deployment](#docker-deployment)
2. [Manual Deployment](#manual-deployment)
3. [Environment Variables](#environment-variables)
4. [Security Considerations](#security-considerations)
5. [Monitoring](#monitoring)
6. [Backup and Recovery](#backup-and-recovery)

## Docker Deployment

### Using Docker Compose (Recommended)

The `SignalZero-Docker` directory provides a complete stack.

#### Basic Deployment

```bash
cd ../SignalZero-Docker
docker-compose up -d
```

#### With Custom Configuration

Create `docker-compose.override.yml`:

```yaml
version: '3.8'
services:
  localnode:
    environment:
      - INFERENCE_PROVIDER=openai
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - INFERENCE_MODEL=gpt-4o
    volumes:
      - ./custom-settings.json:/app/settings.json
```

#### Production Overrides

```yaml
version: '3.8'
services:
  localnode:
    restart: always
    environment:
      - NODE_ENV=production
    logging:
      driver: "json-file"
      options:
        max-size: "100m"
        max-file: "5"
  
  redis:
    restart: always
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
  
  chroma:
    restart: always
    volumes:
      - chroma-data:/chroma/chroma
```

### Building Custom Image

```dockerfile
# Dockerfile.production
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3001

USER node

CMD ["node", "dist/server.js"]
```

Build and push:

```bash
docker build -f Dockerfile.production -t signalzero/localnode:latest .
docker push signalzero/localnode:latest
```

## Manual Deployment

### Server Requirements

- Linux server (Ubuntu 22.04 LTS recommended)
- 4GB+ RAM
- 20GB+ storage
- Node.js 20+

### Step-by-Step

#### 1. Install Dependencies

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Redis
sudo apt-get install redis-server
sudo systemctl enable redis-server

# Install Docker (for ChromaDB)
curl -fsSL https://get.docker.com | sh
```

#### 2. Setup ChromaDB

```bash
docker run -d \
  --name chroma \
  -p 8000:8000 \
  -v /opt/chroma-data:/chroma/chroma \
  --restart always \
  chromadb/chroma:latest
```

#### 3. Deploy Application

```bash
# Create app directory
sudo mkdir -p /opt/signalzero
sudo chown $USER:$USER /opt/signalzero
cd /opt/signalzero

# Clone repository
git clone https://github.com/your-org/signalzero-localnode.git .

# Install dependencies
npm ci --only=production

# Build
npm run build
```

#### 4. Environment Configuration

Create `/opt/signalzero/.env`:

```env
NODE_ENV=production
PORT=3001
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000
CHROMA_COLLECTION=signalzero
INFERENCE_PROVIDER=openai
OPENAI_API_KEY=your_key_here
INFERENCE_MODEL=gpt-4o
```

#### 5. Systemd Service

Create `/etc/systemd/system/signalzero.service`:

```ini
[Unit]
Description=SignalZero LocalNode
After=network.target redis.service

[Service]
Type=simple
User=signalzero
WorkingDirectory=/opt/signalzero
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo useradd -r -s /bin/false signalzero
sudo systemctl daemon-reload
sudo systemctl enable signalzero
sudo systemctl start signalzero
```

#### 6. Reverse Proxy (Nginx)

Create `/etc/nginx/sites-available/signalzero`:

```nginx
server {
    listen 80;
    server_name signalzero.example.com;
    
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable:

```bash
sudo ln -s /etc/nginx/sites-available/signalzero /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### 7. SSL with Let's Encrypt

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d signalzero.example.com
```

## Environment Variables

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3001` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `CHROMA_URL` | ChromaDB URL | `http://localhost:8000` |
| `CHROMA_COLLECTION` | ChromaDB collection name | `signalzero` |

### Inference

| Variable | Description |
|----------|-------------|
| `INFERENCE_PROVIDER` | `local`, `openai`, or `gemini` |
| `INFERENCE_ENDPOINT` | API endpoint (local only) |
| `INFERENCE_MODEL` | Model identifier |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Gemini API key |

### Security

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for signing tokens |
| `INTERNAL_KEY` | Key for service-to-service auth |

### Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level | `info` |
| `LOG_FILE` | Log file path | `logs/app.log` |

## Security Considerations

### 1. Use HTTPS

Always use HTTPS in production. Configure:
- Reverse proxy with SSL termination
- Valid SSL certificate (Let's Encrypt)
- HTTP→HTTPS redirect

### 2. Secure Secrets

```bash
# Generate secure secrets
openssl rand -base64 32  # JWT_SECRET
openssl rand -base64 32  # INTERNAL_KEY
```

Store in environment, never commit to git.

### 3. Redis Security

Enable authentication:
```bash
# redis.conf
requirepass your-secure-password
```

Use Unix socket if on same machine:
```
unixsocket /var/run/redis/redis.sock
unixsocketperm 700
```

### 4. Firewall

```bash
# Allow only necessary ports
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### 5. Rate Limiting

Add to Nginx:
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

server {
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://localhost:3001;
    }
}
```

## Monitoring

### Health Checks

```bash
# System health
curl http://localhost:3001/api/auth/status
```

### Logging

Logs are written to:
- Console (stdout/stderr)
- File: `logs/application-YYYY-MM-DD.log`

View logs:
```bash
# Docker
docker logs -f signalzero-localnode

# Systemd
sudo journalctl -u signalzero -f

# File
tail -f logs/application-$(date +%Y-%m-%d).log
```

### Metrics (Future)

Planned metrics endpoints:
- Request latency
- Token usage
- Cache hit rates
- Active sessions

## Backup and Recovery

### Redis Backup

```bash
# Automated backup (cron)
0 2 * * * redis-cli BGSAVE

# Backup files location
/var/lib/redis/dump.rdb

# Restore
sudo systemctl stop redis
sudo cp /backup/dump.rdb /var/lib/redis/
sudo systemctl start redis
```

### ChromaDB Backup

```bash
# Backup
tar -czf chroma-backup-$(date +%Y%m%d).tar.gz /opt/chroma-data/

# Restore
sudo systemctl stop signalzero
docker stop chroma
tar -xzf chroma-backup-YYYYMMDD.tar.gz -C /
docker start chroma
sudo systemctl start signalzero
```

### Full System Backup

```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d)
BACKUP_DIR=/backups/signalzero/$DATE

mkdir -p $BACKUP_DIR

# Redis
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb $BACKUP_DIR/

# ChromaDB
tar -czf $BACKUP_DIR/chroma.tar.gz /opt/chroma-data/

# Application
tar -czf $BACKUP_DIR/app.tar.gz /opt/signalzero/

# Upload to remote (example with rclone)
rclone sync $BACKUP_DIR remote:signalzero-backups/
```

### Disaster Recovery

1. Provision new server
2. Install dependencies
3. Restore Redis data
4. Restore ChromaDB data
5. Deploy application
6. Verify functionality
