# SignalZero Agent Modification Guidelines

This document outlines the architectural patterns and constraints for AI agents tasked with modifying the SignalZero Kernel (Backend).

## Core Philosophy

SignalZero is **not** a chatbot. It is a **recursive symbolic kernel**.
*   **Symbols** are the atomic units of logic (Patterns, Lattices, Personas).
*   **Domains** are namespaces for symbols.
*   **Traces** are the execution paths of reasoning.

When modifying the system, you must preserve the integrity of the **Symbolic Triad** (Data structure, Visual representation, Semantic logic).

## Project Structure

*   `server.ts`: The Express application entry point. Defines all API routes and middleware.
*   `services/`: Core business logic and state management.
    *   `inferenceService.ts`: Manages the LLM chat session and tool execution loop.
    *   `domainService.ts`: Manages symbol and domain CRUD operations.
    *   `toolsService.ts`: Defines the function calling schema and executors.
    *   `vectorService.ts`: Handles semantic search and embedding generation.
    *   `projectService.ts`: Handles import/export of the system state.
*   `symbolic_system/`:
    *   `activation_prompt.ts`: The core system prompt that defines the kernel's persona.
*   `types.ts`: Centralized type definitions.

## Critical Modification Rules

### 1. Service Layer Pattern
*   Logic should reside in `services/`, not in `server.ts`.
*   `server.ts` should only handle HTTP request/response mapping.
*   Dependencies between services should be managed carefully to avoid circular imports.

### 2. Inference & Tools
*   `inferenceService.ts` is the heart of the agent interaction. It handles the message loop and tool calls.
*   New tools must be registered in `toolsService.ts`. You must define both the **Schema** (for the LLM) and the **Executor** (implementation).

### 3. API Contract
*   The API is consumed by a frontend client. Do not break existing route signatures without updating the client.
*   Ensure all endpoints return JSON.
*   Handle errors gracefully and return appropriate HTTP status codes.

### 4. Context Preservation
*   The `ACTIVATION_PROMPT` in `symbolic_system/activation_prompt.ts` is the "soul" of the kernel. Modifications should enhance its capabilities, not dilute its identity.

### 5. Vector Store
*   `vectorService.ts` handles embeddings. Ensure that any new symbol operations correctly update the vector index if needed.