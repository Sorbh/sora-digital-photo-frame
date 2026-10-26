# Multi-stage build for optimized image size
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies for native modules like sharp
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat \
    vips-dev

# Copy package files
COPY server/package*.json ./

# Install all dependencies (including dev dependencies for potential build steps)
RUN npm ci && npm cache clean --force

# Copy source code
COPY server/ ./

# Production stage
FROM node:18-alpine AS production

# Install only runtime dependencies
RUN apk add --no-cache \
    vips \
    dumb-init

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S photoframe -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY server/package*.json ./

# Install only production dependencies
RUN npm ci --only=production --omit=dev && \
    npm cache clean --force && \
    rm -rf ~/.npm

# Copy application code from builder stage
COPY --from=builder --chown=photoframe:nodejs /app/*.js ./
COPY --from=builder --chown=photoframe:nodejs /app/config ./config
COPY --from=builder --chown=photoframe:nodejs /app/controllers ./controllers
COPY --from=builder --chown=photoframe:nodejs /app/middleware ./middleware
COPY --from=builder --chown=photoframe:nodejs /app/routes ./routes
COPY --from=builder --chown=photoframe:nodejs /app/services ./services
COPY --from=builder --chown=photoframe:nodejs /app/utils ./utils
COPY --from=builder --chown=photoframe:nodejs /app/public ./public

# Create necessary directories and set permissions
RUN mkdir -p uploads data logs && \
    chown -R photoframe:nodejs /app

# Switch to non-root user
USER photoframe

# Expose port (default 3000, can be overridden by PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').request({port:process.env.PORT||3000,path:'/api/health'}, (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)).end()"

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]