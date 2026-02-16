# Getting Started

This guide will help you get SignalZero LocalNode running on your machine.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Docker Setup (Recommended)](#docker-setup-recommended)
3. [Manual Setup](#manual-setup)
4. [Initial Configuration](#initial-configuration)
5. [Verification](#verification)
6. [Next Steps](#next-steps)

## Prerequisites

### Required

- **Node.js** v20 or higher
- **Redis** v6 or higher
- **ChromaDB** v0.4 or higher
- An inference provider (one of):
  - **LM Studio**, **Ollama**, or similar (local)
  - **OpenAI API** key
  - **Google Gemini API** key

### Optional

- **Docker** and **Docker Compose** (for easy full-stack setup)
- **Git** (for version control)

## Docker Setup (Recommended)

The easiest way to run the complete SignalZero stack is using Docker Compose in the `SignalZero-Docker` directory.

### Steps

1. **Navigate to the Docker directory:**
   ```bash
   cd ../SignalZero-Docker
   ```

2. **Start the services:**
   ```bash
   docker-compose up --build
   ```

3. **Access the UI:**
   Open your browser to `http://localhost:3000`

This will start:
- SignalZero LocalNode (backend) on port 3001
- SignalZero LocalChat (frontend) on port 3000
- Redis on port 6379
- ChromaDB on port 8000

## Manual Setup

If you prefer to run services individually:

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Required Services

**Redis:**
```bash
redis-server
```

**ChromaDB:**
```bash
# Using Docker
docker run -p 8000:8000 chromadb/chroma:latest

# Or install locally
pip install chromadb
chroma run --path ./chroma_data
```

**Inference Provider (Example: LM Studio):**
1. Download and install LM Studio
2. Load a model (e.g., Llama 3, Qwen, or similar)
3. Start the local server (default: `http://localhost:1234`)

### 3. Configure Environment

Create a `.env` file in the project root:

```env
# Server
PORT=3001

# Redis
REDIS_URL=redis://localhost:6379

# ChromaDB
CHROMA_URL=http://localhost:8000
CHROMA_COLLECTION=signalzero

# Inference Provider
# Option 1: Local (LM Studio, Ollama, etc.)
INFERENCE_PROVIDER=local
INFERENCE_ENDPOINT=http://localhost:1234/v1
INFERENCE_MODEL=openai/gpt-oss-120b

# Option 2: OpenAI
# INFERENCE_PROVIDER=openai
# OPENAI_API_KEY=your_key_here
# INFERENCE_MODEL=gpt-4o

# Option 3: Gemini
# INFERENCE_PROVIDER=gemini
# GEMINI_API_KEY=your_key_here
# INFERENCE_MODEL=gemini-1.5-flash
```

### 4. Run the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

## Initial Configuration

On first run, the system requires setup:

### 1. Check Status

```bash
curl http://localhost:3001/api/auth/status
```

You should see:
```json
{
  "initialized": false,
  "authenticated": false
}
```

### 2. Run Setup Wizard

```bash
curl -X POST http://localhost:3001/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{
    "adminUsername": "admin",
    "adminPassword": "your-secure-password",
    "inferenceProvider": "local",
    "inferenceEndpoint": "http://localhost:1234/v1",
    "inferenceModel": "openai/gpt-oss-120b"
  }'
```

### 3. Login

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your-secure-password"
  }'
```

Save the returned `token` for subsequent requests.

## Verification

### Test the API

```bash
# Replace <your_token> with the token from login
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: <your_token>" \
  -d '{
    "message": "Hello, SignalZero!"
  }'
```

### Check System Health

```bash
curl http://localhost:3001/api/auth/status
```

Expected response:
```json
{
  "initialized": true,
  "authenticated": true,
  "user": {
    "id": "...",
    "username": "admin",
    "role": "admin"
  }
}
```

## Next Steps

- [API Reference](../api/README.md) - Learn the available endpoints
- [Architecture Overview](../architecture/README.md) - Understand how it works
- [Authentication](../api/authentication.md) - User management and access control
- [MCP Server](../api/mcp.md) - Use with Claude Desktop or other MCP clients

## Troubleshooting

### Redis Connection Failed

**Problem:** `Error: Redis connection to localhost:6379 failed`

**Solution:** Ensure Redis is running:
```bash
redis-cli ping
# Should return: PONG
```

### ChromaDB Connection Failed

**Problem:** `Error: ChromaDB connection failed`

**Solution:** Check ChromaDB is accessible:
```bash
curl http://localhost:8000/api/v1/heartbeat
# Should return: {"nanosecond heartbeat": ...}
```

### Inference Provider Error

**Problem:** `Error: Inference provider returned 404`

**Solution:** 
- Verify your inference endpoint is correct
- Ensure the model is loaded (for local providers)
- Check API key is valid (for cloud providers)

### Port Already in Use

**Problem:** `Error: listen EADDRINUSE: address already in use :::3001`

**Solution:** Kill the existing process or change the PORT in `.env`:
```bash
# Find process using port 3001
lsof -i :3001

# Kill it
kill -9 <PID>
```
