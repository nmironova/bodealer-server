FROM node:22-bookworm-slim

# CMake links Walrus to curses and the C++ runtime; DDS is linked statically.
# procps supports process inspection in the real integration tests; tini reaps
# orphaned native children and forwards container shutdown signals to Node.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 libgcc-s1 libncurses6 libncursesw6 libtinfo6 procps tini file binutils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY exes/linux/ /app/exes/linux/
COPY scripts/check-linux-runtime.sh /app/scripts/check-linux-runtime.sh
RUN sh /app/scripts/check-linux-runtime.sh /app/exes/linux
COPY server.js auth.js ./
COPY test/ ./test/
RUN mkdir -p /app/jobs && chown -R node:node /app
ENV NODE_ENV=production PORT=3001 JOBS_DIR=/app/jobs \
    BODEALER_BIN_DIR=/app/exes/linux MAX_CONCURRENT_TASKS=2
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
