FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY db ./db
USER node
EXPOSE 3000
# One image serves the app and the Graph mock; docker-compose.yml overrides the
# command for the mock with `node dist/mock/mock-main.js`.
CMD ["node", "dist/main.js"]
