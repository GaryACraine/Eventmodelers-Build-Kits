# The sign-in service (ADR-055): one image for the service (`node dist/server.js`) and its migrations
# (`npm run migrate`, run once before a new version starts: Compose's auth-migrate, or the CDK Trigger's task).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
