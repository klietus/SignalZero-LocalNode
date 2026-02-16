# Glossary

Key terms and concepts in SignalZero.

## Core Concepts

### Symbol
A discrete unit of meaning in the symbolic system. Symbols have:
- **Name** - Human-readable identifier
- **Content** - The symbolic meaning/text
- **Domain** - Organizational category
- **Embedding** - Vector representation for semantic search

### Domain
A collection of related symbols. Domains can be:
- **Global** - Shared across all users (e.g., `root`, `cyber_sec`)
- **User-specific** - Private to a single user (e.g., `user`, `state`)

### Symbolic Engine
The recursive reasoning system that:
- Retrieves relevant symbols based on context
- Constructs context windows for LLMs
- Manages symbolic execution loops
- Records reasoning traces

### Context Window
The assembled set of symbols and prompts sent to an LLM for generation. Includes:
- System prompt
- Relevant symbols
- Conversation history

### Trace
A complete record of a reasoning session, including:
- Input/output
- Reasoning steps
- Symbols accessed/created
- Timing information

## System Components

### LocalNode
The backend kernel that powers SignalZero. Handles:
- API requests
- Symbol storage and retrieval
- LLM interactions
- Multi-user management

### LocalChat
The web-based chat interface that communicates with LocalNode.

### Vector Service
The service managing semantic search via ChromaDB.

### Inference Service
The service managing LLM interactions with various providers.

## Data Models

### Redis Key Structure

```
sz:users                    # Set of user IDs
sz:user:{id}                # User record
sz:usernames               # Username → ID mapping
sz:apikeys                 # API key → ID mapping
sz:domains                 # Set of global domain IDs
sz:domain:{id}             # Global domain data
sz:user:{id}:domain:{id}   # User-specific domain
```

### Symbol Types

| Type | Description |
|------|-------------|
| `governance` | Core system principles |
| `pattern` | Recognizable behavior patterns |
| `definition` | Concept definitions |
| `observation` | Recorded observations |
| `state` | Temporary session data |

## Authentication

### Session Token
Short-lived token (24h) for web UI sessions.

### API Key
Persistent key for programmatic access (MCP, scripts).

### Internal Key
Service-to-service authentication key.

## Inference Providers

### Local Provider
OpenAI-compatible local server (LM Studio, Ollama, etc.)

### OpenAI Provider
Direct OpenAI API integration.

### Gemini Provider
Google Gemini API integration.

## Protocols

### MCP (Model Context Protocol)
Protocol for extending AI assistants with tools and resources. SignalZero exposes an MCP server.

### SSE (Server-Sent Events)
HTTP-based protocol for streaming data from server to client. Used for:
- Chat streaming
- MCP connections

### JSON-RPC
Remote procedure call protocol using JSON. Used by MCP for message exchange.

## Tools

### web_search
Search the internet using Brave Search API.

### read_file
Read contents of local files.

### read_url
Fetch and parse web pages.

### parse_pdf
Extract text from PDF documents.

### parse_rss
Read RSS/Atom feeds.

## Security Terms

### Domain Isolation
Separation of user data so users cannot access each other's private domains.

### RBAC (Role-Based Access Control)
Access control based on user roles (`admin`, `user`).

### scrypt
Password hashing algorithm used for secure password storage.

## Deployment Terms

### Docker Compose
Tool for defining and running multi-container Docker applications.

### Systemd
Linux system and service manager used for running SignalZero as a service.

### Reverse Proxy
Server (like Nginx) that forwards client requests to backend services.
