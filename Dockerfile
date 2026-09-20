FROM node:24-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json tsconfig.json tsconfig.test.json ./
RUN npm ci

COPY src ./src
COPY test ./test

CMD ["sh", "-c", "npm run typecheck && npm run typecheck:test && npm test && npm run build"]
