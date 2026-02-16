# Services Documentation

Detailed documentation for each service in the SignalZero kernel.

## Service Overview

| Service | Purpose | Key Methods |
|---------|---------|-------------|
| `authService` | Authentication & authorization | `authenticate()`, `verifyToken()`, `verifyApiKey()` |
| `userService` | User management | `createUser()`, `getUser()`, `updateUser()` |
| `domainService` | Domain management | `createDomain()`, `listDomains()`, `getDomain()` |
| `vectorService` | Vector search | `search()`, `upsert()`, `delete()` |
| `inferenceService` | LLM interactions | `generate()`, `stream()` |
| `contextService` | Context management | `loadStaticContext()`, `loadDynamicContext()` |
| `contextWindowService` | Window construction | `constructContextWindow()` |
| `toolsService` | Tool execution | `execute()`, `registerTool()` |
| `traceService` | Trace recording | `record()`, `get()`, `list()` |
| `redisService` | Redis operations | `get()`, `set()`, `hget()`, `hset()` |
| `embeddingService` | Text embeddings | `embed()`, `embedBatch()` |
| `indexingService` | Symbol indexing | `indexSymbol()`, `reindexDomain()` |
| `projectService` | Import/export | `importProject()`, `exportProject()` |
| `settingsService` | Configuration | `get()`, `set()`, `getInferenceSettings()` |
| `systemPromptService` | Prompt management | `getSystemPrompt()`, `updateSystemPrompt()` |
| `mcpPromptService` | MCP integration | `generatePrompt()`, `handleToolCall()` |
| `secretManagerService` | Secrets storage | `getSecret()`, `setSecret()` |
| `timeService` | Time utilities | `now()`, `format()` |
| `loggerService` | Logging | `info()`, `error()`, `debug()` |

## Authentication Service

**File:** `services/authService.ts`

Handles all authentication concerns.

### Methods

#### `authenticate(credentials: LoginCredentials): Promise<AuthResult>`
Validates username/password and returns session token.

#### `verifyToken(token: string): Promise<AuthContext>`
Validates a session token and returns user context.

#### `verifyApiKey(apiKey: string): Promise<AuthContext>`
Validates an API key and returns user context.

#### `logout(token: string): Promise<void>`
Invalidates a session token.

## User Service

**File:** `services/userService.ts`

Manages user accounts and profiles.

### Methods

#### `createUser(request: CreateUserRequest): Promise<User>`
Creates a new user with hashed password and API key.

#### `getUser(id: string): Promise<User | null>`
Retrieves a user by ID.

#### `getUserByUsername(username: string): Promise<User | null>`
Finds a user by username.

#### `listUsers(): Promise<User[]>`
Lists all users (admin only).

#### `updateUser(id: string, updates: UpdateUserRequest): Promise<User>`
Updates user fields (password, role, etc.).

#### `deleteUser(id: string): Promise<void>`
Deletes a user and their data.

## Domain Service

**File:** `services/domainService.ts`

Manages symbolic domains.

### Methods

#### `createDomain(userId: string | undefined, domain: CreateDomainRequest): Promise<Domain>`
Creates a new domain (global if userId is undefined).

#### `listDomains(userId: string, options?: ListOptions): Promise<Domain[]>`
Lists domains visible to the user.

#### `getDomain(userId: string, domainId: string): Promise<Domain | null>`
Gets a specific domain if user has access.

#### `updateDomain(userId: string, domainId: string, updates: UpdateDomainRequest): Promise<Domain>`
Updates domain metadata.

#### `deleteDomain(userId: string, domainId: string): Promise<void>`
Deletes a domain and all its symbols.

### Domain Isolation

```typescript
// Global domain
sz:domain:{domainId}

// User-specific domain
sz:user:{userId}:domain:{domainId}
```

## Vector Service

**File:** `services/vectorService.ts`

Manages ChromaDB interactions for semantic search.

### Methods

#### `search(query: string, options?: SearchOptions): Promise<SearchResult[]>`
Searches for symbols by semantic similarity.

#### `upsert(symbol: Symbol): Promise<void>`
Adds or updates a symbol in the vector store.

#### `delete(symbolId: string): Promise<void>`
Removes a symbol from the vector store.

#### `deleteByDomain(domainId: string): Promise<void>`
Removes all symbols in a domain.

## Inference Service

**File:** `services/inferenceService.ts`

Manages LLM interactions.

### Methods

#### `generate(request: GenerateRequest): Promise<GenerateResponse>`
Generates a response from the LLM.

#### `stream(request: StreamRequest): AsyncIterable<StreamChunk>`
Streams a response from the LLM.

#### `getAvailableModels(): Promise<ModelInfo[]>`
Lists available models from the provider.

### Supported Providers

- `local` - OpenAI-compatible local endpoint
- `openai` - OpenAI API
- `gemini` - Google Gemini API

## Context Window Service

**File:** `services/contextWindowService.ts`

Constructs context windows for LLM requests.

### Methods

#### `constructContextWindow(userId: string, request: ContextRequest): Promise<ContextWindow>`
Builds a context window including:
- System prompt
- User's user/state domains
- Relevant symbols from search
- Conversation history

### Context Priority

1. System prompt (highest priority)
2. User domain symbols
3. State domain symbols
4. Retrieved relevant symbols
5. Current message

## Tools Service

**File:** `services/toolsService.ts`

Executes external tools.

### Built-in Tools

| Tool | Description |
|------|-------------|
| `web_search` | Search the web using Brave API |
| `read_file` | Read local file contents |
| `read_url` | Fetch and parse web page |
| `parse_pdf` | Extract text from PDF |
| `parse_rss` | Read RSS feeds |

### Methods

#### `execute(toolName: string, parameters: object): Promise<ToolResult>`
Executes a tool with given parameters.

#### `registerTool(tool: ToolDefinition): void`
Registers a custom tool.

## Trace Service

**File:** `services/traceService.ts`

Records complete reasoning traces.

### Methods

#### `record(trace: TraceRecord): Promise<string>`
Records a new trace, returns trace ID.

#### `get(traceId: string): Promise<Trace | null>`
Retrieves a trace by ID.

#### `list(userId: string, options?: ListOptions): Promise<Trace[]>`
Lists traces for a user.

### Trace Structure

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
  latency: number;
  tokenUsage?: TokenUsage;
}
```

## Redis Service

**File:** `services/redisService.ts`

Low-level Redis operations.

### Methods

#### `get(key: string): Promise<string | null>`
Gets a string value.

#### `set(key: string, value: string, ttl?: number): Promise<void>`
Sets a string value with optional TTL.

#### `hget(key: string, field: string): Promise<string | null>`
Gets a hash field.

#### `hset(key: string, field: string, value: string): Promise<void>`
Sets a hash field.

#### `del(key: string): Promise<void>`
Deletes a key.

#### `keys(pattern: string): Promise<string[]>`
Finds keys matching pattern.

## Settings Service

**File:** `services/settingsService.ts`

Manages system configuration.

### Methods

#### `get(key: string): Promise<any>`
Gets a setting value.

#### `set(key: string, value: any): Promise<void>`
Sets a setting value.

#### `getInferenceSettings(): Promise<InferenceSettings>`
Gets current inference provider settings.

#### `setInferenceSettings(settings: InferenceSettings): Promise<void>`
Updates inference provider settings.
