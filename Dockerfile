# Use Node.js 20 on Alpine Linux for a small footprint
FROM node:20-alpine

# Install FFmpeg (Required for video processing)
# python3/make/g++ required for some node_modules build (bcrypt, etc.)
RUN apk add --no-cache ffmpeg python3 make g++

# Set working directory
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install dependencies (including devDependencies to build certain packages, then prune)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the Typescript code (if you have a build script)
# Or for this setup, we might run with tsx directly in production for simplicity
# removing 'npm run build' if it just compiles TS to JS, unless we strictly want to run node dist/index.js
# For stability with current setup, we'll keep using tsx or build if strictly defined. 
# Looking at package.json, "build": "tsx script/build.ts" might do something specific.
# Let's try to assume we run source with tsx for maximum compatibility with the current dev setup.
# IF you prefer compiled:
# RUN npm run build

# Expose the API port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000

# Start command
# Using tsx for direct execution as it handles ESM/TS paths gracefully
# (Ensure tsx is installed or use npx)
CMD ["npx", "tsx", "server/index.ts"]
