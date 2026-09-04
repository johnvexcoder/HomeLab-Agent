FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl lm-sensors vnstat smartmontools procps iputils-ping \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
ENV STATE_DIR=/var/lib/homelab-agent
RUN mkdir -p /var/lib/homelab-agent
USER root
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["sh", "-c", "kill -0 1"]
CMD ["node", "dist/index.js"]
