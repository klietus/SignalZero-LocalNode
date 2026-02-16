# Authentication & Authorization

Complete guide to authentication, users, and access control in SignalZero.

## Table of Contents

- [Overview](#overview)
- [User Model](#user-model)
- [Authentication Methods](#authentication-methods)
- [User Management](#user-management)
- [Domain Isolation](#domain-isolation)
- [MCP Server Authentication](#mcp-server-authentication)
- [Redis Key Structure](#redis-key-structure)
- [Security Considerations](#security-considerations)
- [Migration from Single-User](#migration-from-single-user)

## Overview

SignalZero supports multiple users with domain isolation. Each user has:
- Unique credentials (username/password)
- API key for programmatic access
- Personal `user` and `state` domains
- Access to shared global domains

## User Model

### User Object

```typescript
interface User {
  id: string;           // Unique user ID (e.g., "user_a1b2c3...")
  username: string;     // Unique username
  passwordHash: string; // scrypt hash
  salt: string;         // Password salt
  apiKey: string;       // API key for MCP access (starts with "sz_")
  role: 'admin' | 'user';
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp
  enabled: boolean;     // Account status
}
```

### User Roles

| Role | Description |
|------|-------------|
| `admin` | Full system access, can manage other users |
| `user` | Standard access, can only manage own domains |

## Authentication Methods

SignalZero supports three authentication methods in priority order:

### 1. X-Internal-Key (Service-to-Service)

For internal service-to-service communication. Bypasses user checks for local access.

```bash
curl -H "X-Internal-Key: <internal_key>" \
  http://localhost:3001/api/...
```

Set via environment variable:
```bash
INTERNAL_SERVICE_KEY=your_secret_key_here
```

### 2. X-API-Key (Programmatic Access)

For MCP and programmatic access. Persistent key tied to a user account.

```bash
curl -H "X-API-Key: sz_apikey_xxx" \
  http://localhost:3001/api/users/me
```

API keys are generated on user creation and can be regenerated via the API.

### 3. X-Auth-Token / Session Cookie (Web UI)

For web UI sessions. Short-lived tokens (24-hour lifetime).

```bash
# Login to get token
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "secure_password"}'

# Use token
curl -H "X-Auth-Token: <session_token>" \
  http://localhost:3001/api/users/me
```

## User Management

### Initial Setup

On first run, the system requires initialization:

```bash
# Check status
curl http://localhost:3001/api/auth/status

# Setup (creates admin user)
curl -X POST http://localhost:3001/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "secure_password",
    "inference": { "provider": "local", "endpoint": "..." }
  }'
```

### Login

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "secure_password"}'
```

Response:
```json
{
  "token": "session_token_here",
  "user": {
    "id": "user_xxx",
    "name": "admin",
    "role": "admin",
    "apiKey": "sz_..."
  }
}
```

### Change Password

```bash
curl -X POST http://localhost:3001/api/auth/change-password \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: <session_token>" \
  -d '{
    "oldPassword": "current_password",
    "newPassword": "new_secure_password"
  }'
```

### Create User (Admin Only)

```bash
curl -X POST http://localhost:3001/api/users \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: <admin_session_token>" \
  -d '{
    "username": "newuser",
    "password": "secure_password",
    "role": "user"
  }'
```

Response includes the API key:
```json
{
  "id": "user_def456",
  "username": "newuser",
  "role": "user",
  "apiKey": "sz_apikey_xyz789...",
  "createdAt": "2024-01-15T11:00:00Z"
}
```

### List Users (Admin Only)

```bash
curl -H "X-Auth-Token: <admin_session_token>" \
  http://localhost:3001/api/users
```

Response:
```json
{
  "users": [
    {
      "id": "user_xxx",
      "username": "admin",
      "role": "admin",
      "enabled": true,
      "createdAt": "2026-02-06T...",
      "updatedAt": "2026-02-06T...",
      "apiKey": "sz_..."
    }
  ]
}
```

### Get Current User

```bash
curl -H "X-Auth-Token: <session_token>" \
  http://localhost:3001/api/users/me
```

### Get User by ID

```bash
curl -H "X-Auth-Token: <session_token>" \
  http://localhost:3001/api/users/:id
```

### Update User

```bash
curl -X PATCH http://localhost:3001/api/users/:id \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: <session_token>" \
  -d '{
    "username": "newname",
    "password": "newpassword",
    "role": "user",
    "enabled": true,
    "apiKey": "regenerate"
  }'
```

Note: Use `"apiKey": "regenerate"` to generate a new API key.

### Delete User (Admin Only)

```bash
curl -X DELETE http://localhost:3001/api/users/:id \
  -H "X-Auth-Token: <admin_session_token>"
```

### Logout

```bash
curl -X POST http://localhost:3001/api/auth/logout \
  -H "X-Auth-Token: <session_token>"
```

## Domain Isolation

### User-Specific Domains (Isolated)

Each user automatically gets these private domains:
- **`user`** - User preferences, anchors, and personal symbols
- **`state`** - Session-specific state symbols

These are only accessible to the owning user.

### Global Domains (Shared)

All authenticated users can read from global domains:
- `root` - Core governance, invariants
- `interfaces` - Tools, MCP interfaces
- `cyber_sec` - Security patterns, CVEs
- `ethics` - Ethics patterns
- `formal_logic` - Logic patterns
- `narrative_psychology` - Psychology patterns
- All other domains

### Context Window Construction

The context window service includes user-specific context:

1. **System Prompt** (global)
2. **Stable Context**: All global domains (root, interfaces, cyber_sec, etc.)
3. **User Context**: User's `user` domain + `state` domain only
4. **Dynamic Context**: User-specific state with `[USER_CONTEXT userId="xxx"]` marker

Example context injection:
```
[KERNEL]
[DOMAINS]
| root | Root Domain | ... |
| interfaces | Interfaces | ... |
| cyber_sec | Cyber Security | ... |

[SELF]
| SELF-RECURSIVE-CORE | ... | ... |

[ROOT]
| ROOT-SYNTHETIC-CORE | ... | ... |

[DYNAMIC_STATE]
[USER_CONTEXT userId="user_abc123"]
[USER_PREFERENCES]
| pref_dark_mode | Dark Mode | ... |

[STATE]
| state_1 | Recent State | ... |

[SYSTEM_METADATA]
...
```

## MCP Server Authentication

The MCP (Model Context Protocol) server uses API key authentication.

### SSE Endpoint

```bash
curl -N \
  -H "X-API-Key: sz_your_api_key" \
  -H "Accept: text/event-stream" \
  http://localhost:3001/mcp/sse
```

### JSON-RPC Messages

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sz_your_api_key" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }' \
  "http://localhost:3001/mcp/messages?sessionId=<session_id>"
```

### Supported MCP Methods

#### Initialize
```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {}
  },
  "id": 1
}
```

#### List Tools
```json
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 1
}
```

#### Call Tool
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_symbols",
    "arguments": {
      "query": "security",
      "limit": 10
    }
  },
  "id": 1
}
```

### Claude Desktop Configuration

```json
{
  "mcpServers": {
    "signalzero": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-remote"],
      "env": {
        "MCP_REMOTE_URL": "http://localhost:3001/mcp",
        "MCP_REMOTE_API_KEY": "sz_your_api_key"
      }
    }
  }
}
```

## Redis Key Structure

```
# Users Index
sz:users                    # Set of all user IDs
sz:usernames               # Hash: username -> userId
sz:apikeys                 # Hash: apiKey -> userId

# User Record
sz:user:{userId}           # User data (JSON)

# Global Domains
sz:domains                 # Set of global domain IDs
sz:domain:{domainId}       # Domain data (JSON)

# User-Specific Domains
sz:user:{userId}:domain:user   # User's user domain
sz:user:{userId}:domain:state  # User's state domain
```

## Security Considerations

### Password Storage
- Passwords are hashed using **scrypt** with unique salts
- Never store or transmit plaintext passwords

### API Keys
- API keys are cryptographically secure random strings
- Keys can be regenerated if compromised
- Store keys securely (environment variables, not code)

### Session Tokens
- Session tokens expire after 24 hours
- Tokens are invalidated on logout
- Use HTTPS in production to prevent token interception

### Domain Isolation
- Users cannot access other users' private domains
- Global domains are readable by all authenticated users
- Internal service key bypasses user checks (use carefully)

### Authorization
- Only admins can create/delete users
- Users can only modify their own profile
- Role-based access control (RBAC) enforced at API level

## Migration from Single-User

### Existing Admin User

When the system starts with an existing legacy admin user (from settings.json):
1. The legacy admin is migrated to the new user system
2. The user ID becomes the legacy admin's username
3. All existing global domains remain accessible

### Existing Domains

- Global domains stay in `sz:domain:{domainId}`
- User-specific domains need to be explicitly created per user
- The `user` and `state` domains are auto-initialized when first accessed

### Resetting the System

To completely reset authentication (⚠️ **DESTRUCTIVE**):

```bash
# Clear all Redis data
redis-cli FLUSHDB

# Re-run setup
curl -X POST http://localhost:3001/api/auth/setup \
  -d '{"username": "admin", "password": "..."}'
```

## Testing

Run the authentication tests:

```bash
# User service tests
npm test -- tests/userService.test.ts

# Multi-user auth integration tests
npm test -- tests/authMultiUser.test.ts

# All tests
npm test
```

## Troubleshooting

### Authentication Failed

Check which auth method you're using:

```bash
# Test session token
curl -H "X-Auth-Token: <token>" http://localhost:3001/api/auth/status

# Test API key
curl -H "X-API-Key: <key>" http://localhost:3001/api/users/me

# Test internal key
curl -H "X-Internal-Key: <key>" http://localhost:3001/api/auth/status
```

### Token Expired

Session tokens expire after 24 hours. Re-login to get a new token.

### User Locked Out

If admin is locked out:
1. Use internal key for recovery access
2. Or reset the system (destructive)

### MCP Connection Issues

1. Verify API key is correct
2. Check user has not been disabled
3. Verify server is accessible from client
