# VoxMorph server: the app + call server in one small container.
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts
COPY . .
RUN node scripts/vendor.mjs

FROM node:22-slim
WORKDIR /srv
COPY --from=build /src/app ./app
COPY --from=build /src/server ./server
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.mjs"]
