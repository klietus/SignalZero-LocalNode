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

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app .

# Install runtime utilities, GitHub CLI, Google Cloud CLI, and Gemini CLI
RUN apt-get update && apt-get install -y \
    curl \
    procps \
    ca-certificates \
    gnupg \
    apt-transport-https \
    lsb-release \
    && \
    # GitHub CLI Setup
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    # Google Cloud CLI Setup
    curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list && \
    # Install Tools
    apt-get update && apt-get install -y gh google-cloud-cli && \
    # Gemini CLI
    npm install -g @google/gemini-cli && \
    # Cleanup
    rm -rf /var/lib/apt/lists/*

ENV PORT=3001
EXPOSE 3001

# Using npm start which runs "tsx server.ts"
CMD ["npm", "start"]
