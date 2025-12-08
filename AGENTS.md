
# SignalZero Agent Modification Guidelines

This document outlines the architectural patterns and constraints for AI agents tasked with modifying the SignalZero codebase.

## Core Philosophy

SignalZero is **not** a chatbot. It is a **recursive symbolic kernel**. 
*   **Symbols** are the atomic units of logic (Patterns, Lattices, Personas).
*   **Domains** are namespaces for symbols.
*   **Traces** are the execution paths of reasoning.

When modifying the system, you must preserve the integrity of the **Symbolic Triad** (Data structure, Visual representation, Semantic logic).

## Project Structure

*   `src/components/`: UI components. `ChatMessage.tsx` is critical for parsing symbolic tags.
*   `src/services/`: Core logic.
    *   `inferenceService.ts`: Interaction with LLM. Handles the `sz_trace` parsing.
    *   `domainService.ts`: CRUD for symbols in `localStorage`.
    *   `vectorService.ts`: Handles semantic search and embedding generation.
    *   `toolsService.ts`: Defines the function calling schema for the LLM.
*   `src/types.ts`: Centralized type definitions (`SymbolDef`, `TraceData`, etc.).

## Critical Modification Rules

### 1. Symbol Parsing & Rendering
The application relies on specific XML-like tags in the LLM response to render interactive elements.
*   **DO NOT** break the Regex parsing in `ChatMessage.tsx`.
*   **Tags**:
    *   `<sz_symbol>JSON</sz_symbol>`: Renders a clickable symbol tag.
    *   `<sz_trace>JSON</sz_trace>`: Renders a collapsible reasoning trace.
    *   `<sz_domain>JSON</sz_domain>`: Renders a domain tag.

### 2. Service Layer Pattern
*   All state persistence logic resides in `services/`.
*   Components should **never** access `localStorage` directly for domain data; use `domainService`.
*   Components should **never** call the LLM directly (except for streaming chat); use `inferenceService.ts`.

### 3. Vector Database
*   The system supports a dual-mode vector store:
    1.  **Local (Default)**: In-memory embeddings stored in `localStorage` with client-side cosine similarity.
    2.  **External**: Connects to a self-hosted ChromaDB instance via REST API.
*   When modifying `vectorService.ts`, ensure both paths are maintained.
*   **Chroma API**: Use **v2** endpoints (`/api/v2/collections/...`). Do not revert to v1.

### 4. Tool Definitions
*   Tools are defined in `services/toolsService.ts`.
*   If you add a new capability to the LLM, you must:
    1.  Add the `FunctionDeclaration` in `toolDeclarations`.
    2.  Implement the logic in `createToolExecutor`.

### 5. UI/UX Standards
*   Use **Tailwind CSS** for styling.
*   Use **Lucide React** for icons.
*   Maintain the "Dark Mode / Cyberpunk / Terminal" aesthetic.
*   Ensure the interface feels "technical" but accessible.

## Context Preservation
When refactoring, ensure that the `ACTIVATION_PROMPT` in `symbolic_system/activation_prompt.ts` is preserved or enhanced, never simplified. This prompt establishes the "Kernel" persona.
