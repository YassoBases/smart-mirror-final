FROM node:20-bookworm-slim

# node-gyp toolchain for native deps (sqlite3); sharp ships prebuilt binaries.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install runtime deps inside the image so native binaries match linux (the host
# node_modules are win32 and are excluded via .dockerignore).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Image/DB data persists via a mounted volume at /app/data (see docker-compose).
EXPOSE 3000 4000
CMD ["node", "server.js"]
