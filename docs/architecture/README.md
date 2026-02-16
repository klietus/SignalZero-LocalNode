# Architecture Overview

This document describes the high-level architecture of SignalZero LocalNode.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SignalZero LocalNode                      │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │   Web UI    │    │   MCP/CLI   │    │   External Tools    │  │
│  │  (Chat)     │    │   Clients   │    │   (Search, etc.)    │  │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘  │
│         │                  │                      │              │
│         └──────────────────┼──────────────────────┘              │
│                            │                                     │
│                   ┌────────▼────────┐                            │
│                   │   REST API      │                            │
│                   │   (Express)     │                            │
│                   └────────┬────────┘                            │
│                            │                                     │
│         ┌──────────────────┼──────────────────┐                  │
│         │                  │                  │                  │
│    ┌────▼────┐      ┌──────▼──────┐    ┌──────▼──────┐          │
│    │  Auth   │      │   Symbolic  │    │   Context   │          │
│    │ Service │      │   Engine    │    │   Service   │          │
│    └────┬────┘      └──────┬──────┘    └──────┬──────┘          │
│         │                  │                  │                  │
│    ┌────▼──────────────────▼──────────────────▼──────┐          │
│    │              Service Layer                      │          │
│    │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │          │
│    │  │ Domain │ │ Vector │ │Inference│ │ Tools  │  │          │
│    │  │Service │ │Service │ │Service │ │Service │  │          │
│    │  └────────┘ └────────┘ └────────┘ └────────┘  │          │
│    └────────────────────┬───────────────────────────┘          │
│                         │                                      │
│    ┌────────────────────┼────────────────────┐                 │
│    │              Persistence Layer           │                 │
│    │  ┌──────────┐              ┌──────────┐  │                 │
│    │  │  Redis   │              │ ChromaDB │  │                 │
│    │  │(Primary) │              │(Vectors) │  │                 │
│    │  └──────────┘              └──────────┘  │                 │
│    └──────────────────────────────────────────┘                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. REST API (Express Server)

**File:** `server.ts`

The main entry point. Handles:
- HTTP request routing
- Authentication middleware
- API endpoint definitions
- SSE streaming for chat
- MCP protocol endpoints

### 2. Authentication Service

**File:** `services/authService.ts`

Manages:
- Session token generation and validation
- API key authentication
- Password hashing (scrypt)
- User role verification

### 3. User Service

**File:** `services/userService.ts`

Handles:
- User CRUD operations
- User-domain associations
- API key management

### 4. Domain Service

**File:** `services/domainService.ts`

Manages:
- Domain creation and deletion
- Global vs user-specific domains
- Domain metadata

### 5. Symbolic Engine

**Files:** 
- `services/inferenceService.ts`
- `services/contextWindowService.ts`

The core reasoning engine:
- Constructs context windows from relevant symbols
- Manages LLM interactions
- Handles recursive reasoning loops
- Tracks reasoning traces

### 6. Vector Service

**File:** `services/vectorService.ts`

Integrates with ChromaDB for:
- Semantic symbol search
- Similarity-based retrieval
- Embedding generation

### 7. Context Service

**File:** `services/contextService.ts`

Manages:
- Static context (system knowledge)
- Dynamic context (runtime symbols)
- Domain-specific context loading

### 8. Tools Service

**File:** `services/toolsService.ts`

Provides:
- Web search
- File reading
- RSS feed parsing
- PDF parsing
- Custom tool registration

### 9. Trace Service

**File:** `services/traceService.ts`

Records:
- Complete reasoning traces
- Symbol access patterns
- Decision pathways

## Data Flow

### Chat Request Flow

```
1. Client sends message to POST /api/chat
2. Auth middleware validates token/API key
3. ContextWindowService constructs context:
   a. Load user's user/state domains
   b. Search for relevant symbols
   c. Build context window
4. InferenceService sends to LLM
5. Symbolic reasoning loop (if needed)
6. TraceService records the interaction
7. Response returned to client
```

### Symbol Search Flow

```
1. Client sends search query
2. VectorService embeds query
3. ChromaDB returns similar symbols
4. DomainService filters by permissions
5. Results returned with similarity scores
```

## Data Model

### User
```typescript
{
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  apiKey?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Domain
```typescript
{
  id: string;
  name: string;
  description?: string;
  userId?: string;  // undefined = global
  createdAt: Date;
  updatedAt: Date;
}
```

### Symbol
```typescript
{
  id: string;
  name: string;
  content: string;
  domainId: string;
  embedding?: number[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}
```

### Trace
```typescript
{
  id: string;
  userId: string;
  timestamp: Date;
  input: string;
  output: string;
  reasoning: ReasoningStep[];
  symbolsAccessed: string[];
  symbolsCreated: string[];
  metadata?: Record<string, any>;
}
```

## External Integrations

### Inference Providers

- **Local:** LM Studio, Ollama, llama.cpp
- **Cloud:** OpenAI, Google Gemini

### Vector Database

- **ChromaDB** - Local or remote

### Persistence

- **Redis** - All data storage

### MCP (Model Context Protocol)

- Compatible with Claude Desktop
- SSE-based streaming
- JSON-RPC protocol

## Security Model

1. **Authentication:** Tokens, API keys, internal keys
2. **Authorization:** Role-based access control
3. **Isolation:** User-specific domains
4. **Encryption:** Password hashing, HTTPS recommended for production

## Scalability Considerations

Current architecture is designed for single-node deployment:
- Redis can be clustered
- ChromaDB can run separately
- Stateless API servers can be replicated

For high availability, consider:
- Redis Sentinel or Cluster
- ChromaDB server mode
- Load balancer for API servers
