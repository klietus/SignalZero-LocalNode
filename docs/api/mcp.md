# MCP Server Documentation

SignalZero exposes an MCP (Model Context Protocol) server for integration with Claude Desktop and other MCP clients.

## What is MCP?

The Model Context Protocol (MCP) is a protocol for extending AI assistants with custom tools and context. SignalZero's MCP server allows Claude and other clients to:

- Query the symbolic knowledge base
- Access user domains and symbols
- Use SignalZero as a memory provider

## Configuration

### Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "signalzero": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-remote"],
      "env": {
        "MCP_REMOTE_URL": "http://localhost:3001/mcp",
        "MCP_REMOTE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### API Key

Get your API key from an admin user:

```bash
curl -X POST http://localhost:3001/api/users \
  -H "X-Auth-Token: <admin_token>" \
  -d '{"username": "claude-user", "password": "...", "role": "user"}'
```

The response includes `apiKey` for MCP access.

## Endpoints

### SSE Endpoint

```
GET /mcp/sse
```

**Headers:**
- `X-API-Key: <api_key>`

Establishes a Server-Sent Events connection for MCP communication.

### Messages Endpoint

```
POST /mcp/messages
```

**Headers:**
- `X-API-Key: <api_key>`
- `Content-Type: application/json`

**Body:** JSON-RPC 2.0 messages

## MCP Capabilities

### Tools

SignalZero exposes these MCP tools:

#### `search_symbols`

Search the symbolic knowledge base.

**Parameters:**
```json
{
  "query": "coercion detection",
  "domain": "cyber_sec",
  "limit": 10
}
```

**Returns:**
```json
[
  {
    "id": "symbol_abc123",
    "name": "Coercion Pattern",
    "content": "A pattern where...",
    "score": 0.89
  }
]
```

#### `get_symbol`

Retrieve a specific symbol.

**Parameters:**
```json
{
  "symbolId": "symbol_abc123"
}
```

#### `list_domains`

List available domains.

**Parameters:**
```json
{
  "includeGlobal": true,
  "includeUser": true
}
```

#### `create_symbol`

Create a new symbol.

**Parameters:**
```json
{
  "domainId": "my-domain",
  "name": "New Symbol",
  "content": "Symbol content...",
  "metadata": {"tags": ["important"]}
}
```

### Resources

SignalZero provides these MCP resources:

#### `domains://list`

List of available domains.

#### `symbols://{domainId}`

Symbols in a specific domain.

#### `user://profile`

Current user's profile.

### Prompts

SignalZero provides these MCP prompts:

#### `symbolic_reasoning`

Guided symbolic reasoning prompt.

**Arguments:**
- `topic` - Topic to reason about
- `context` - Additional context

## Example Usage

### With Claude Desktop

Once configured, you can ask Claude:

> "Search SignalZero for information about coercion patterns"

Claude will use the MCP server to query your knowledge base.

### Direct API

```bash
# Initialize SSE connection
curl -N \
  -H "X-API-Key: sz_apikey_xxx" \
  -H "Accept: text/event-stream" \
  http://localhost:3001/mcp/sse

# Send a message (from SSE session)
curl -X POST \
  -H "X-API-Key: sz_apikey_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_symbols",
      "arguments": {
        "query": "trust restoration"
      }
    }
  }' \
  http://localhost:3001/mcp/messages
```

## Security

- API keys are required for all MCP access
- Users can only access their own domains
- Session tokens are not accepted for MCP
- All access is logged

## Troubleshooting

### Connection Refused

Ensure the server is running:
```bash
curl http://localhost:3001/api/auth/status
```

### Authentication Failed

Verify your API key:
```bash
curl -H "X-API-Key: your-key" http://localhost:3001/api/users/me
```

### Claude Can't Connect

Check Claude Desktop logs:
- macOS: `~/Library/Logs/Claude/`
- Windows: `%APPDATA%\Claude\Logs\`

## Advanced Configuration

### Custom MCP Client

```typescript
import { Client } from '@anthropic/mcp-client';

const client = new Client({
  transport: {
    type: 'sse',
    url: 'http://localhost:3001/mcp/sse',
    headers: {
      'X-API-Key': 'sz_apikey_xxx'
    }
  }
});

await client.connect();

const result = await client.callTool('search_symbols', {
  query: 'coercion'
});
```

### Multiple Users

Each user has their own API key and domain isolation:

```json
{
  "mcpServers": {
    "signalzero-admin": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-remote"],
      "env": {
        "MCP_REMOTE_URL": "http://localhost:3001/mcp",
        "MCP_REMOTE_API_KEY": "${SZ_ADMIN_API_KEY}"
      }
    },
    "signalzero-personal": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-remote"],
      "env": {
        "MCP_REMOTE_URL": "http://localhost:3001/mcp",
        "MCP_REMOTE_API_KEY": "${SZ_PERSONAL_API_KEY}"
      }
    }
  }
}
```
