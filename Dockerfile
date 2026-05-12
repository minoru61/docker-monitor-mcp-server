# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for typescript)
RUN npm install

# Copy source code and tsconfig
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript code
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled code from builder
COPY --from=builder /app/build ./build

# The server needs to listen on the port defined in the env, defaulting to 8081
EXPOSE 8081

# Since we need to access /var/run/docker.sock, we run as root (default in node image).
# Note: For strict security, you could create a docker group and add a non-root user,
# but mounting the docker socket already implies root-level access to the host.
CMD ["node", "build/server/index.js"]
