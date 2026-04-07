# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app
RUN addgroup -S claws && adduser -S claws -G claws

COPY --from=build /app/dist/ dist/
COPY tools/ tools/
COPY config/betterclaws.docker.json config/betterclaws.json

RUN mkdir -p data/logs data/sessions data/memory data/scratch \
    && chown -R claws:claws /app

USER claws

EXPOSE 18700 18701

CMD ["node", "dist/src/index.js"]
