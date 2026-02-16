# API Reference

Complete reference for the SignalZero LocalNode REST API.

## Table of Contents

- [Authentication](authentication.md) - Auth methods, users, and access control
- [Users](#users)
- [Chat](#chat)
- [Domains](#domains)
- [Symbols](#symbols)
- [Projects](#projects)
- [Traces](#traces)
- [Tools](#tools)
- [MCP Server](#mcp-server)

## Base URL

```
http://localhost:3001/api
```

## Authentication

### Authentication Methods

The API supports three authentication methods:

1. **Session Token** (`X-Auth-Token`) - For web UI sessions
2. **API Key** (`X-API-Key`) - For programmatic/MCP access
3. **Internal Key** (`X-Internal-Key`) - For service-to-service communication

### Auth Endpoints

#### Check Status
```http
GET /api/auth/status
```

Returns initialization and authentication status.

**Response:**
```json
{
  "initialized": true,
  "authenticated": true,
  "user": {
    "id": "user_abc123",
    "username": "admin",
    "role": "admin"
  }
}
```

#### Setup (First Run)
```http
POST /api/auth/setup
```

Initialize the system with admin account and inference settings.

**Request:**
```json
{
  "adminUsername": "admin",
  "adminPassword": "secure-password",
  "inferenceProvider": "local",
  "inferenceEndpoint": "http://localhost:1234/v1",
  "inferenceModel": "openai/gpt-oss-120b"
}
```

#### Login
```http
POST /api/auth/login
```

Authenticate and receive a session token.

**Request:**
```json
{
  "username": "admin",
  "password": "secure-password"
}
```

**Response:**
```json
{
  "token": "sz_token_abc123...",
  "user": {
    "id": "user_abc123",
    "username": "admin",
    "role": "admin"
  }
}
```

#### Logout
```http
POST /api/auth/logout
```

Invalidate the current session token.

## Users

### List Users (Admin Only)
```http
GET /api/users
```

**Headers:** `X-Auth-Token: <admin_token>`

**Response:**
```json
[
  {
    "id": "user_abc123",
    "username": "admin",
    "role": "admin",
    "createdAt": "2024-01-15T10:30:00Z"
  }
]
```

### Create User (Admin Only)
```http
POST /api/users
```

**Headers:** `X-Auth-Token: <admin_token>`

**Request:**
```json
{
  "username": "newuser",
  "password": "user-password",
  "role": "user"
}
```

**Response:**
```json
{
  "id": "user_def456",
  "username": "newuser",
  "role": "user",
  "apiKey": "sz_apikey_xyz789...",
  "createdAt": "2024-01-15T11:00:00Z"
}
```

### Get Current User
```http
GET /api/users/me
```

**Headers:** `X-Auth-Token: <token>`

### Get User by ID
```http
GET /api/users/:id
```

### Update User
```http
PATCH /api/users/:id
```

**Request:**
```json
{
  "password": "new-password",
  "role": "admin"
}
```

### Delete User (Admin Only)
```http
DELETE /api/users/:id
```

## Chat

### Send Message
```http
POST /api/chat
```

**Headers:** `X-Auth-Token: <token>`

**Request:**
```json
{
  "message": "Explain symbolic reasoning",
  "domainId": "root",
  "stream": false
}
```

**Response:**
```json
{
  "response": "Symbolic reasoning is...",
  "traceId": "trace_abc123",
  "symbolsCreated": ["symbol_1", "symbol_2"]
}
```

### Stream Response (SSE)
```http
POST /api/chat
```

**Request:**
```json
{
  "message": "Explain symbolic reasoning",
  "stream": true
}
```

Returns Server-Sent Events with partial responses.

## Domains

### List Domains
```http
GET /api/domains
```

**Headers:** `X-Auth-Token: <token>`

**Query Parameters:**
- `includeGlobal` (boolean) - Include global domains
- `includeUser` (boolean) - Include user-specific domains

**Response:**
```json
[
  {
    "id": "root",
    "name": "Root Domain",
    "description": "Core governance domain",
    "isGlobal": true
  },
  {
    "id": "user",
    "name": "User Domain",
    "description": "Personal user symbols",
    "isGlobal": false,
    "userId": "user_abc123"
  }
]
```

### Create Domain
```http
POST /api/domains
```

**Request:**
```json
{
  "id": "my-domain",
  "name": "My Domain",
  "description": "Custom domain for my project"
}
```

### Get Domain
```http
GET /api/domains/:id
```

### Update Domain
```http
PATCH /api/domains/:id
```

**Request:**
```json
{
  "name": "Updated Name",
  "description": "Updated description"
}
```

### Delete Domain
```http
DELETE /api/domains/:id
```

## Symbols

### Search Symbols
```http
GET /api/symbols/search
```

**Query Parameters:**
- `q` (string, required) - Search query
- `domain` (string) - Filter by domain
- `limit` (number) - Max results (default: 10)

**Response:**
```json
[
  {
    "id": "symbol_abc123",
    "name": "Coercion Pattern",
    "domainId": "cyber_sec",
    "content": "A pattern where...",
    "score": 0.89
  }
]
```

### List Symbols in Domain
```http
GET /api/domains/:id/symbols
```

### Get Symbol
```http
GET /api/symbols/:id
```

### Create/Update Symbol
```http
POST /api/domains/:id/symbols
```

**Request:**
```json
{
  "id": "my-symbol",
  "name": "My Symbol",
  "content": "Symbol content here...",
  "metadata": {
    "tags": ["important", "review"]
  }
}
```

### Delete Symbol
```http
DELETE /api/symbols/:id
```

## Projects

### Import Project
```http
POST /api/project/import
```

**Content-Type:** `multipart/form-data`

**Fields:**
- `file` - `.szproject` file

### Export Project
```http
POST /api/project/export
```

**Request:**
```json
{
  "domainIds": ["domain1", "domain2"],
  "includeHistory": true
}
```

**Response:** Binary `.szproject` file

## Traces

### List Traces
```http
GET /api/traces
```

**Query Parameters:**
- `limit` (number)
- `offset` (number)
- `domain` (string)

### Get Trace
```http
GET /api/traces/:id
```

**Response:**
```json
{
  "id": "trace_abc123",
  "timestamp": "2024-01-15T10:30:00Z",
  "input": "Explain symbolic reasoning",
  "output": "Symbolic reasoning is...",
  "reasoning": [
    {"step": 1, "action": "retrieved_context", "details": "..."},
    {"step": 2, "action": "generated_response", "details": "..."}
  ],
  "symbolsAccessed": ["sym1", "sym2"],
  "symbolsCreated": ["sym3"]
}
```

## Tools

### List Available Tools
```http
GET /api/tools
```

**Response:**
```json
[
  {
    "name": "web_search",
    "description": "Search the web",
    "parameters": {
      "query": {"type": "string", "required": true}
    }
  }
]
```

### Execute Tool
```http
POST /api/tools/execute
```

**Request:**
```json
{
  "tool": "web_search",
  "parameters": {
    "query": "symbolic reasoning"
  }
}
```

## MCP Server

SignalZero exposes an MCP (Model Context Protocol) server for integration with Claude Desktop and other MCP clients.

### SSE Endpoint
```http
GET /mcp/sse
```

**Headers:** `X-API-Key: <api_key>`

Establishes Server-Sent Events connection for MCP.

### Messages Endpoint
```http
POST /mcp/messages
```

**Headers:** 
- `X-API-Key: <api_key>`
- `Content-Type: application/json`

Sends JSON-RPC messages to the MCP server.

See [MCP Documentation](mcp.md) for full details.

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Invalid or missing token |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request data |
| `INTERNAL_ERROR` | 500 | Server error |

## Rate Limits

Currently no rate limiting is enforced, but this may change in future versions.

## OpenAPI Specification

For a complete OpenAPI/Swagger specification, see [`openapi.yaml`](../../openapi.yaml) in the project root.
