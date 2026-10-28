FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
ENV ONNXRUNTIME_NODE_INSTALL=skip ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations
RUN npm run build

FROM build AS test
COPY benchmark ./benchmark
COPY scripts ./scripts
COPY docs/shared-memory-policy.md ./docs/shared-memory-policy.md
COPY skills/shared-memory ./skills/shared-memory
CMD ["npm", "run", "test:integration"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:24.22.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 MODEL_CACHE=/models
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
RUN mkdir /models && chown node:node /models
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
