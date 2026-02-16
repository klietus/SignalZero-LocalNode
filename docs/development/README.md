# Development Guide

Guide for contributing to SignalZero LocalNode.

## Table of Contents

1. [Development Setup](#development-setup)
2. [Project Structure](#project-structure)
3. [Coding Standards](#coding-standards)
4. [Testing](#testing)
5. [Adding Features](#adding-features)
6. [Debugging](#debugging)
7. [Submitting Changes](#submitting-changes)

## Development Setup

### 1. Clone and Install

```bash
cd ~/workspace/LocalNode/SignalZero-LocalNode
npm install
```

### 2. Environment Setup

Create a `.env` file for development:

```env
PORT=3001
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000
CHROMA_COLLECTION=signalzero
INFERENCE_PROVIDER=local
INFERENCE_ENDPOINT=http://localhost:1234/v1
INFERENCE_MODEL=openai/gpt-oss-120b
```

### 3. Start Services

```bash
# Terminal 1: Redis
redis-server

# Terminal 2: ChromaDB
docker run -p 8000:8000 chromadb/chroma:latest

# Terminal 3: Development server
npm run dev
```

## Project Structure

```
SignalZero-LocalNode/
├── server.ts              # Main Express application
├── types.ts               # TypeScript interfaces and types
├── services/              # Business logic layer
│   ├── authService.ts
│   ├── userService.ts
│   └── ...
├── scripts/               # Utility and maintenance scripts
│   ├── cleanup_state_symbols.ts
│   └── ...
├── tests/                 # Test suite
│   ├── unit/
│   └── integration/
├── docs/                  # Documentation
└── dist/                  # Compiled output (generated)
```

## Coding Standards

### TypeScript

- Use strict TypeScript settings
- Define interfaces for all data structures
- Avoid `any` - use `unknown` with type guards
- Document public methods with JSDoc

### Example

```typescript
/**
 * Creates a new user in the system.
 * @param request - User creation parameters
 * @returns The created user object
 * @throws ValidationError if username is taken
 */
export async function createUser(
  request: CreateUserRequest
): Promise<User> {
  // Validate input
  if (!request.username || !request.password) {
    throw new ValidationError('Username and password required');
  }

  // Implementation...
}
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | camelCase | `userService.ts` |
| Classes | PascalCase | `UserService` |
| Functions | camelCase | `createUser()` |
| Constants | SCREAMING_SNAKE | `MAX_RETRY_COUNT` |
| Interfaces | PascalCase | `CreateUserRequest` |
| Types | PascalCase | `UserRole` |

### Error Handling

Always use typed errors:

```typescript
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
  }
}
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/userService.test.ts

# Run in watch mode
npm test -- --watch
```

### Test Structure

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createUser } from '../services/userService';

describe('userService', () => {
  beforeEach(async () => {
    // Setup
  });

  describe('createUser', () => {
    it('should create a user with valid data', async () => {
      const user = await createUser({
        username: 'testuser',
        password: 'password123'
      });

      expect(user.username).toBe('testuser');
      expect(user.id).toBeDefined();
    });

    it('should reject duplicate usernames', async () => {
      await expect(createUser({
        username: 'existing',
        password: 'password123'
      })).rejects.toThrow('Username already exists');
    });
  });
});
```

### Test Categories

1. **Unit tests** - Test individual functions in isolation
2. **Integration tests** - Test service interactions
3. **API tests** - Test HTTP endpoints

## Adding Features

### Adding a New Service

1. Create file in `services/`:
```typescript
// services/myService.ts
export interface MyServiceOptions {
  // Options
}

export async function myFunction(
  options: MyServiceOptions
): Promise<Result> {
  // Implementation
}
```

2. Add tests in `tests/myService.test.ts`
3. Export from appropriate index if needed
4. Document in `docs/services/README.md`

### Adding a New API Endpoint

1. Add route in `server.ts`:
```typescript
app.post('/api/my-feature', authenticate, async (req, res) => {
  try {
    const result = await myService.handle(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
```

2. Add to OpenAPI spec in `openapi.yaml`
3. Document in `docs/api/README.md`
4. Add integration tests

### Adding a New Tool

1. Register in `services/toolsService.ts`:
```typescript
registerTool({
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    input: { type: 'string', required: true }
  },
  handler: async (params) => {
    // Tool implementation
    return { result: 'success' };
  }
});
```

2. Add tests
3. Document in tools reference

## Debugging

### Logging

Use the logger service:

```typescript
import { logger } from './services/loggerService';

logger.info('Operation completed', { userId, duration });
logger.error('Operation failed', { error, context });
logger.debug('Debug info', { details });
```

### Debug Mode

Run with debug logging:

```bash
DEBUG=signalzero:* npm run dev
```

### Common Issues

#### Redis Connection
```bash
# Check Redis
redis-cli ping

# Monitor Redis commands
redis-cli monitor
```

#### ChromaDB Connection
```bash
# Check ChromaDB
curl http://localhost:8000/api/v1/heartbeat
```

#### TypeScript Errors
```bash
# Check types
npx tsc --noEmit
```

### Using VS Code Debug

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Server",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "tsx",
      "args": ["server.ts"],
      "env": {
        "DEBUG": "signalzero:*"
      }
    }
  ]
}
```

## Submitting Changes

### Before Committing

1. **Run tests:**
   ```bash
   npm test
   ```

2. **Check types:**
   ```bash
   npx tsc --noEmit
   ```

3. **Lint (if configured):**
   ```bash
   npm run lint
   ```

### Commit Message Format

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `test`: Tests
- `refactor`: Code refactoring
- `chore`: Maintenance

Examples:
```
feat(auth): add API key authentication

fix(vector): handle null embeddings gracefully
docs(api): update user endpoints documentation
```

### Pull Request Checklist

- [ ] Tests pass
- [ ] Type checking passes
- [ ] Documentation updated
- [ ] API spec updated (if applicable)
- [ ] CHANGELOG.md updated
