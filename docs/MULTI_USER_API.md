# Multi-User Support Implementation

## Overview
SignalZero LocalNode now supports multiple users with domain isolation. Each user has their own `user` and `state` domains, while sharing global domains like `root`, `interfaces`, `cyber_sec`, etc.

## User Model

### User Object
```typescript
interface User {
  id: string;           // Unique user ID (e.g., "user_a1b2c3...")
  username: string;     // Unique username
  passwordHash: string; // bcrypt/scrypt hash
  salt: string;         // Password salt
  apiKey: string;       // API key for MCP access (starts with "sz_")
  role: 'admin' | 'user';
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp
  enabled: boolean;     // Account status
}
```

### User Roles
- **admin**: Full access, can manage other users
- **user**: Standard access, can only manage own domains

## API Endpoints

### Authentication

#### Check Auth Status
```http
GET /api/auth/status
```
Response:
```json
{
  "initialized": true,
  "authenticated": true,
  "user": {
    "userId": "user_xxx",
    "username": "admin",
    "role": "admin"
  }
}
```

#### Setup (First Run)
```http
POST /api/auth/setup
Content-Type: application/json

{
  "username": "admin",
  "password": "secure_password",
  "inference": { /* optional */ }
}
```

#### Login (Session-based)
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "secure_password"
}
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

#### Change Password
```http
POST /api/auth/change-password
Content-Type: application/json
X-Auth-Token: <session_token>

{
  "oldPassword": "current_password",
  "newPassword": "new_secure_password"
}
```

### User Management (Admin Only)

#### List Users
```http
GET /api/users
X-Auth-Token: <admin_session_token>
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

#### Create User
```http
POST /api/users
Content-Type: application/json
X-Auth-Token: <admin_session_token>

{
  "username": "newuser",
  "password": "secure_password",
  "role": "user"
}
```

#### Get Current User
```http
GET /api/users/me
X-Auth-Token: <session_token>
```

#### Get User by ID
```http
GET /api/users/:id
X-Auth-Token: <session_token>
```

#### Update User
```http
PATCH /api/users/:id
Content-Type: application/json
X-Auth-Token: <session_token>

{
  "username": "newname",
  "password": "newpassword",
  "role": "user",
  "enabled": true,
  "apiKey": "regenerate"  // Special value to regenerate API key
}
```

#### Delete User
```http
DELETE /api/users/:id
X-Auth-Token: <admin_session_token>
```

## MCP Server API

The MCP (Model Context Protocol) server provides SSE and JSON-RPC endpoints for tool access.

### Authentication
Use `X-API-Key` header with your user's API key, or `X-Internal-Key` for internal service access.

### Endpoints

#### SSE Endpoint
```http
GET /mcp/sse
X-API-Key: sz_your_api_key
```

Returns a Server-Sent Events stream with endpoint information.

#### JSON-RPC Messages
```http
POST /mcp/messages?sessionId=<session_id>
Content-Type: application/json
X-API-Key: sz_your_api_key

{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 1
}
```

### Supported Methods

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

## Domain Isolation

### User-Specific Domains (Isolated)
- `user` - User preferences, anchors, and personal symbols
- `state` - Session-specific state symbols

### Global Domains (Shared)
- `root` - Core governance, invariants
- `interfaces` - Tools, MCP interfaces
- `cyber_sec` - Security patterns, CVEs
- `ethics` - Ethics patterns
- `formal_logic` - Logic patterns
- `narrative_psychology` - Psychology patterns
- All other domains

### Redis Key Structure

```
# Users
sz:users                    # Set of user IDs
sz:user:{userId}            # User record (hash)
sz:usernames                # Hash: username -> userId
sz:apikeys                  # Hash: apiKey -> userId

# Global Domains
sz:domains                  # Set of global domain IDs
sz:domain:{domainId}        # Domain data

# User-Specific Domains
sz:user:{userId}:domain:user   # User's user domain
sz:user:{userId}:domain:state  # User's state domain
```

## Context Window Construction

The context window service now includes user-specific context:

1. **System Prompt** (global)
2. **Stable Context**: All global domains (root, interfaces, cyber_sec, etc.)
3. **User Context**: User's `user` domain + `state` domain only
4. **Dynamic Context**: User-specific state with `[USER_CONTEXT userId="xxx"]` marker

### Example Context Injection
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

## Security

### Authentication Methods (in priority order)
1. **X-Internal-Key**: For internal service-to-service communication
2. **X-API-Key**: For MCP and programmatic access
3. **Session Cookie/X-Auth-Token**: For web UI access

### Authorization
- Users can only access their own `user` and `state` domains
- Global domains are readable by all authenticated users
- Only admins can create/delete users
- Users can modify their own profile and API key

## Testing

Run the multi-user tests:
```bash
npm test -- tests/userService.test.ts
npm test -- tests/authMultiUser.test.ts
```

## Environment Variables

```bash
# Internal service key for MCP/local access
INTERNAL_SERVICE_KEY=your_secret_key_here
```
