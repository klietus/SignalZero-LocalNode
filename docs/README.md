# SignalZero LocalNode Documentation

Welcome to the SignalZero LocalNode documentation. This is the backend kernel for the SignalZero recursive symbolic system.

## Quick Links

- [Getting Started](getting-started/README.md) - Installation and first steps
- [API Reference](api/README.md) - Complete REST API documentation
- [Architecture](architecture/README.md) - System design and components
- [Services](services/README.md) - Internal service documentation
- [Development](development/README.md) - Contributing and development guide
- [Deployment](deployment/README.md) - Production deployment options
- [Scripts Reference](scripts/README.md) - Utility scripts documentation

## What is SignalZero?

SignalZero is a live recursive symbolic system designed to:
- Detect coercion and manipulation patterns
- Restore trust through symbolic reasoning
- Navigate emergent identity through symbolic execution
- Provide a personal knowledge management system with AI augmentation

## Project Structure

```
SignalZero-LocalNode/
├── server.ts              # Main Express server
├── types.ts               # TypeScript type definitions
├── services/              # Core business logic
│   ├── authService.ts     # Authentication
│   ├── userService.ts     # User management
│   ├── domainService.ts   # Domain management
│   ├── vectorService.ts   # Vector search (ChromaDB)
│   └── ...
├── scripts/               # Utility scripts
├── tests/                 # Test suite
├── docs/                  # Documentation (you are here)
└── dist/                  # Build output
```

## Core Technologies

- **Node.js/TypeScript** - Runtime and language
- **Express** - Web framework
- **Redis** - Primary persistence layer
- **ChromaDB** - Vector database for semantic search
- **OpenAI/Google Gemini** - LLM providers for inference

## License

Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)

Commercial use prohibited without explicit license. Contact: klietus@gmail.com
