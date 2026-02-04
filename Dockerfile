# Use Node.js 20 Slim (Debian-based) for better compatibility with native modules (bcrypt, sharp, etc.)
# This avoids compiling from source (which is slow on Alpine)
FROM node:20-slim

# Install FFmpeg and python3/build-essential for any remaining native builds
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install dependencies using npm ci (faster and more reliable than npm install)
# builds all dependencies including devDependencies (needed for build scripts like tsx)
RUN npm ci

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000

# Start command
# Using tsx directly for simplicity as per original setup
CMD ["npx", "tsx", "server/index.ts"]
