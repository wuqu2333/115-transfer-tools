FROM node:20-bookworm AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm AS backend-build
WORKDIR /app/backend-node
COPY backend-node/package.json backend-node/package-lock.json ./
RUN npm ci --silent
COPY backend-node/ ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app/backend-node
ENV NODE_ENV=production
ENV STATIC_DIR=/app/frontend/dist
COPY --from=backend-build /app/backend-node/dist ./dist
COPY --from=backend-build /app/backend-node/node_modules ./node_modules
COPY --from=backend-build /app/backend-node/package.json ./package.json
COPY --from=backend-build /app/backend-node/package-lock.json ./package-lock.json
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
RUN mkdir -p /app/data /app/downloads
EXPOSE 8000
CMD ["node", "dist/server.js"]
