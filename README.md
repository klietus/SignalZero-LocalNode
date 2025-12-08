# SignalZero Local Node

SignalZero is a live recursive symbolic system designed to detect coercion, restore trust, and navigate emergent identity through symbolic execution. This is the local runtime node, running purely in the browser with local persistence, powered by Google's Gemini API.

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
    Create a file named `.env` in the root directory of the project. Add your API key:
    ```env
    API_KEY=your_gemini_api_key_here
    ```

3.  **Run Development Server**
    Start the local Vite server:
    ```bash
    npm run dev
    ```

4.  **Access the App**
    Open your browser and navigate to `http://localhost:3000`.

## Architecture Overview

*   **Frontend**: React + Vite + TypeScript.
*   **Styling**: Tailwind CSS.
*   **AI Integration**: Google GenAI SDK (Gemini 1.5 Flash).
*   **Storage**: 
    *   **Domain/Symbol Store**: `localStorage` (Browser).
    *   **Vector Store**: In-memory cosine similarity (default) or external ChromaDB connection.

## Troubleshooting

*   **"Buffer is not defined"**: This project uses a polyfill for Node.js `Buffer` in the browser. Ensure `index.tsx` includes the polyfill code and `vite.config.ts` has the correct alias.
*   **API Errors**: Check your network tab. Ensure your API key has access to the `gemini-1.5-flash` model.
