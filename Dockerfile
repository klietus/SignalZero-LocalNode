# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies (including devDependencies for tsx)
RUN npm ci

# Copy source code
COPY . .

# Final stage
FROM node:20-slim

WORKDIR /app

# Install runtime utilities and dependencies for tfjs-node
RUN apt-get update && apt-get install -y \
    curl \
    procps \
    ca-certificates \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app .

ENV PORT=3001
EXPOSE 3001

# Using npm start which runs "tsx server.ts"
CMD ["npm", "start"]
