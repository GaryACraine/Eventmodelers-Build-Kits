# The sign-in service (ADR-055): one image for the service (`node dist/server.js`) and its migrations
# (`npm run migrate`, run once before a new version starts: Compose's auth-migrate, or the CDK Trigger's task).
# Images are pinned to an exact version (ADR-063); a release records each one's digest.
FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Only what runs (ADR-063). `better-auth` lists vitest as an optional peer, so npm counts the test tooling as
# production and `npm prune --omit=dev` keeps it. Without the dev dependencies listed, the install against the same
# lockfile leaves it out and changes no version.
FROM node:24.21.0-alpine AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm pkg delete devDependencies && npm install --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
