# SignalZero Kernel (Backend Node)

SignalZero is a live recursive symbolic system designed to detect coercion, restore trust, and navigate emergent identity through symbolic execution. This repository contains the **backend kernel**, a Node.js/Express server that powers the symbolic reasoning engine, manages persistence, and coordinates tool execution.

## Features

*   **Symbolic Engine:** Recursive reasoning engine that utilizes large language models to manipulate abstract symbols.
*   **Vector Search:** Integrated **ChromaDB** support for semantic search and retrieval of symbols.
*   **Persistence:** Uses **Redis** for fast, persistent storage of domains, symbols, and system state.
*   **Tool Execution:** Extensible tool system enabling the kernel to perform actions (web search, file reading, etc.).
*   **Multi-Model Support:** Native support for Local Inference (OpenAI-compatible), OpenAI (GPT-4), and Google Gemini.
*   **Authentication:** Secure token-based authentication system with an initial setup wizard.
*   **Dockerized:** Fully containerized setup for easy deployment.

## Prerequisites

*   **Node.js** (v20+ recommended)
*   **Redis** (v6+)
*   **ChromaDB** (v0.4+)
*   **Inference Provider** (e.g., LM Studio running Llama 3, OpenAI API key, or Gemini API key)

## Quick Start (Docker)

The easiest way to run the full stack (Node, Chat, Redis, Chroma) is via the Docker Compose setup in the `SignalZero-Docker` directory.

1.  Navigate to `SignalZero-Docker`.
2.  Run `docker-compose up --build`.
3.  Access the UI at `http://localhost:3000`.

## Manual Setup

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Environment Configuration**
    Create a `.env` file or rely on `settings.json` (managed via the API).
    
    Default Environment Variables:
    ```env
    PORT=3001
    REDIS_URL=redis://localhost:6379
    CHROMA_URL=http://localhost:8000
    CHROMA_COLLECTION=signalzero
    INFERENCE_PROVIDER=local
    INFERENCE_ENDPOINT=http://localhost:1234/v1
    INFERENCE_MODEL=openai/gpt-oss-120b
    ```

3.  **Run Server**
    ```bash
    # Development (Watch Mode)
    npm run dev

    # Production
    npm start
    ```

## API Documentation

The kernel exposes a RESTful API on port `3001` (by default).

### Authentication
*   `POST /api/auth/setup`: Initialize the system (Admin account, inference settings).
*   `POST /api/auth/login`: Authenticate and receive a session token.
*   `GET /api/auth/status`: Check initialization and authentication status.

### Core Operations
*   `POST /api/chat`: Send a message to the kernel.
*   `GET /api/traces`: Retrieve reasoning traces.
*   `POST /api/project/import`: Import a full `.szproject` state.
*   `POST /api/project/export`: Export current state.

### Domain & Symbol Management
*   `GET /api/domains`: List all domains.
*   `POST /api/domains`: Create a new domain.
*   `GET /api/symbols/search`: Semantic search for symbols.
*   `POST /api/domains/:id/symbols`: Upsert a symbol.

(See source code `server.ts` for the complete route list)

## License

**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**

Commercial use of this software is strictly prohibited under this license. To obtain a license for commercial use, please contact: `klietus@gmail.com`.