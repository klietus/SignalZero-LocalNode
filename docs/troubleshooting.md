# Troubleshooting Guide

Common issues and their solutions.

## Installation Issues

### npm install fails

**Symptoms:**
```
npm ERR! code ECONNREFUSED
npm ERR! syscall connect
```

**Solutions:**
1. Check internet connection
2. Clear npm cache: `npm cache clean --force`
3. Use different registry: `npm config set registry https://registry.npmjs.org/`
4. Try with `--legacy-peer-deps` flag

### TypeScript compilation errors

**Symptoms:**
```
error TS2307: Cannot find module
```

**Solutions:**
1. Ensure all dependencies installed: `npm install`
2. Check `tsconfig.json` is present
3. Run `npx tsc --noEmit` to see all errors

## Runtime Issues

### Redis Connection Failed

**Symptoms:**
```
Error: Redis connection to localhost:6379 failed
```

**Solutions:**
1. Check Redis is running:
   ```bash
   redis-cli ping
   ```
   Should return `PONG`

2. Start Redis:
   ```bash
   redis-server
   # or
   sudo systemctl start redis
   ```

3. Check Redis URL in `.env`:
   ```env
   REDIS_URL=redis://localhost:6379
   ```

4. Check Redis authentication (if enabled):
   ```env
   REDIS_URL=redis://:password@localhost:6379
   ```

### ChromaDB Connection Failed

**Symptoms:**
```
Error: ChromaDB connection failed
```

**Solutions:**
1. Check ChromaDB is running:
   ```bash
   curl http://localhost:8000/api/v1/heartbeat
   ```

2. Start ChromaDB:
   ```bash
   docker run -p 8000:8000 chromadb/chroma:latest
   ```

3. Check ChromaDB URL in `.env`:
   ```env
   CHROMA_URL=http://localhost:8000
   ```

### Inference Provider Error

**Symptoms:**
```
Error: Inference provider returned 404
Error: Connection refused
```

**Solutions:**

**For Local Provider:**
1. Verify inference server is running (LM Studio, Ollama, etc.)
2. Check endpoint URL matches:
   ```env
   INFERENCE_ENDPOINT=http://localhost:1234/v1
   ```
3. Ensure model is loaded in the inference server

**For OpenAI:**
1. Verify API key:
   ```bash
   curl https://api.openai.com/v1/models \
     -H "Authorization: Bearer $OPENAI_API_KEY"
   ```
2. Check API key is set in `.env`:
   ```env
   OPENAI_API_KEY=sk-...
   ```

**For Gemini:**
1. Verify API key at https://makersuite.google.com/app/apikey
2. Check key is set in `.env`:
   ```env
   GEMINI_API_KEY=...
   ```

### Port Already in Use

**Symptoms:**
```
Error: listen EADDRINUSE: address already in use :::3001
```

**Solutions:**
1. Find process using port:
   ```bash
   # macOS/Linux
   lsof -i :3001
   
   # Windows
   netstat -ano | findstr :3001
   ```

2. Kill process:
   ```bash
   kill -9 <PID>
   ```

3. Or change port in `.env`:
   ```env
   PORT=3002
   ```

## Authentication Issues

### Invalid Token

**Symptoms:**
```json
{"error": {"code": "UNAUTHORIZED", "message": "Invalid token"}}
```

**Solutions:**
1. Token may have expired (24h lifetime)
2. Re-login to get new token
3. Check token is being sent correctly:
   ```bash
   curl -H "X-Auth-Token: your-token" ...
   ```

### Setup Already Completed

**Symptoms:**
```
Error: System already initialized
```

**Solutions:**
1. System can only be initialized once
2. To reset, clear Redis:
   ```bash
   redis-cli FLUSHDB
   ```
   ⚠️ Warning: This deletes all data!

### Login Failed

**Symptoms:**
```json
{"error": {"code": "UNAUTHORIZED", "message": "Invalid credentials"}}
```

**Solutions:**
1. Verify username/password
2. Check if user exists:
   ```bash
   redis-cli HGET sz:usernames yourusername
   ```
3. If admin locked out, check internal key access

## Data Issues

### Symbols Not Found

**Symptoms:**
Search returns no results for known symbols.

**Solutions:**
1. Check symbol exists:
   ```bash
   curl -H "X-Auth-Token: token" \
     http://localhost:3001/api/symbols/SYMBOL_ID
   ```

2. Reindex if needed:
   ```bash
   npx tsx scripts/reindex_all.ts
   ```

3. Check ChromaDB connection

### Corrupted Data

**Symptoms:**
Unexpected errors when accessing domains or symbols.

**Solutions:**
1. Run integrity check scripts:
   ```bash
   npx tsx scripts/fix_user_core.ts
   ```

2. If severe, restore from backup:
   ```bash
   # Stop services
   sudo systemctl stop signalzero
   
   # Restore Redis
   sudo cp /backup/dump.rdb /var/lib/redis/
   
   # Restart
   sudo systemctl start signalzero
   ```

## Performance Issues

### Slow Responses

**Possible Causes:**
1. Large context windows
2. Slow inference provider
3. Redis/ChromaDB latency

**Solutions:**
1. Check inference latency:
   ```bash
   time curl -X POST http://localhost:3001/api/chat \
     -H "X-Auth-Token: token" \
     -d '{"message": "test"}'
   ```

2. Monitor Redis:
   ```bash
   redis-cli INFO stats
   ```

3. Check logs for slow queries

### Memory Issues

**Symptoms:**
```
FATAL ERROR: Reached heap limit
```

**Solutions:**
1. Increase Node.js memory:
   ```bash
   NODE_OPTIONS="--max-old-space-size=4096" npm start
   ```

2. Restart server periodically
3. Clean up old traces:
   ```bash
   npx tsx scripts/cleanup_state_symbols.ts --older-than 1
   ```

## MCP Issues

### Claude Can't Connect

**Symptoms:**
Claude Desktop shows "Connecting..." or errors.

**Solutions:**
1. Verify API key:
   ```bash
   curl -H "X-API-Key: your-key" \
     http://localhost:3001/api/users/me
   ```

2. Check Claude Desktop logs:
   - macOS: `~/Library/Logs/Claude/mcp.log`

3. Verify MCP endpoints:
   ```bash
   curl http://localhost:3001/mcp/sse \
     -H "X-API-Key: key" \
     -H "Accept: text/event-stream"
   ```

### MCP Tools Not Working

**Symptoms:**
Claude sees tools but they return errors.

**Solutions:**
1. Check user has access to requested domains
2. Verify tool parameters are correct
3. Check server logs for tool execution errors

## Getting Help

If issues persist:

1. **Check logs:**
   ```bash
   tail -f logs/application-$(date +%Y-%m-%d).log
   ```

2. **Run diagnostics:**
   ```bash
   curl http://localhost:3001/api/auth/status
   ```

3. **Enable debug mode:**
   ```bash
   DEBUG=signalzero:* npm run dev
   ```

4. **Contact:**
   - GitHub Issues: [repository]/issues
   - Email: klietus@gmail.com
