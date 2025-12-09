# SignalZero Kernel (Backend Node)

SignalZero is a live recursive symbolic system designed to detect coercion, restore trust, and navigate emergent identity through symbolic execution. This repository contains the **backend kernel**, a Node.js/Express server that powers the symbolic reasoning engine.

## Prerequisites

*   **Node.js** (v18 or higher recommended)
*   **npm**
*   A **Google Gemini API Key** (Get one at [aistudio.google.com](https://aistudio.google.com))

## Setup Instructions

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Environment Configuration**
    Create a file named `.env` in the root directory. Add your API key:
    ```env
    API_KEY=your_gemini_api_key_here
    PORT=3000
    ```

3.  **Run Development Server**
    Start the server in watch mode:
    ```bash
    npm run dev
    ```

4.  **Production Start**
    ```bash
    npm start
    ```

The server will start on `http://localhost:3000` (or your configured PORT).

## Architecture Overview

*   **Runtime**: Node.js + Express + TypeScript.
*   **AI Integration**: Google GenAI SDK (Gemini 1.5 Flash/Pro).
*   **Architecture**: Service-based (Domain, Inference, Project, Tools).
*   **Persistence**: In-memory (transient) or file-based (project export/import).

## API Endpoints

The server exposes a comprehensive RESTful API for interacting with the kernel.

### Chat & System
*   `POST /api/chat`: Send a message to the kernel (streaming response logic handled internally, returns full response).
*   `POST /api/chat/reset`: Reset the current conversation context and traces.
*   `GET /api/system/prompt`: Retrieve the current active system prompt (activation prompt).
*   `POST /api/system/prompt`: Update the active system prompt.

### Domain Management
*   `GET /api/domains`: List metadata for all domains.
*   `GET /api/domains/:id/exists`: Check if a domain exists.
*   `GET /api/domains/:id/enabled`: Check if a domain is enabled.
*   `POST /api/domains/:id/toggle`: Enable/Disable a domain.
*   `PATCH /api/domains/:id`: Update domain metadata (name, description, invariants).
*   `DELETE /api/domains/:id`: Delete a domain and all its symbols.
*   `POST /api/admin/clear-all`: **Destructive**: Clear all domains and symbols.

### Symbol Management
*   `GET /api/symbols/search?q=...`: Semantic search for symbols across all domains.
*   `GET /api/symbols/:id`: Retrieve a specific symbol by its global ID.
*   `POST /api/symbols/refactor`: Execute a batch refactor operation on symbols.
*   `POST /api/symbols/compress`: Compress multiple symbols into a new one.
*   `GET /api/domains/:id/symbols`: List all symbols in a specific domain.
*   `GET /api/domains/:id/query`: Filter symbols in a domain (by tag, etc.).
*   `POST /api/domains/:id/symbols`: Create or Update (Upsert) a symbol.
*   `POST /api/domains/:id/symbols/bulk`: Bulk Upsert symbols.
*   `DELETE /api/domains/:domainId/symbols/:symbolId`: Delete a specific symbol (optional `?cascade=true`).
*   `POST /api/domains/:domainId/symbols/rename`: Rename a symbol and propagate changes.

### Testing Framework
*   `GET /api/tests/sets`: List all test sets.
*   `POST /api/tests/sets`: Create or update a test set.
*   `DELETE /api/tests/sets/:id`: Delete a test set.
*   `POST /api/tests`: Add a prompt and expected activations to a specific test set.
*   `POST /api/tests/runs`: Start a new test run for a given test set (optionally include `compareWithBaseModel: true`).
*   `GET /api/tests/runs`: List past test runs.
*   `GET /api/tests/runs/:id`: Get details of a specific test run.

Each test case records `expectedActivations` (symbol IDs that must appear in the trace). Missing activations mark the test as failed.

### Project & State
*   `POST /api/project/export`: Export the entire system state (domains, symbols, prompt) as a `.szproject` file.
*   `POST /api/project/import`: Restore system state from a `.szproject` file.
*   `GET /api/traces`: Retrieve the current execution reasoning traces.