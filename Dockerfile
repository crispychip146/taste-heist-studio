FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY vendor ./vendor
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
ENV QLOO_BASE_URL=https://hackathon.api.qloo.com QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3100
VOLUME ["/app/data"]
CMD ["node", "server/index.mjs"]
