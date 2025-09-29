FROM node:22-alpine AS base

# 1. Install dependencies only when needed
FROM base AS deps

WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN \
    if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then yarn global add pnpm && pnpm i; \
    else echo "Lockfile not found." && exit 1; \
    fi

# 2. Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Select env file at build time (development|production)
ARG ENV_NAME=production
# Ensure local-only env files never affect container builds
RUN rm -f .env.local .env.development.local .env.production.local || true
# Copy the appropriate env file based on ENV_NAME
RUN \
    if [ "$ENV_NAME" = "development" ] && [ -f .env.development ]; then \
        cp .env.development .env.production; \
    elif [ "$ENV_NAME" = "production" ] && [ -f .env.production ]; then \
        echo "Using existing .env.production"; \
    fi
# Use deploy next.config.js for container builds
RUN if [ -f deploy.next.config.js ]; then cp deploy.next.config.js next.config.js; fi

RUN yarn build;

# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static


USER nextjs

# expose port
EXPOSE 8080

ENV PORT=8080

# start
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
