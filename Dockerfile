FROM node:22-alpine

WORKDIR /app

# 零第三方依赖，直接拷贝源码即可
COPY package.json ./
COPY server.js ./
COPY config.example.json ./config.example.json
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
