FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY data/profile.json /app/profile.default.json
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "dist/main.js"]
