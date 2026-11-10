# oikos-webbot-frontend: ein Container, liefert das Chatfenster aus und ist der BFF zur Agent Runtime.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run setzt PORT selbst auf 8080; lokal läuft der BFF ohne Container auf 8090.
ENV PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/tenants ./tenants
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
