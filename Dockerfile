FROM node:20-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/woi && chown node:node /home/woi

WORKDIR /home/node/app
RUN chown node:node /home/node/app

USER node

# cswap and its uv venv are bind-mounted from the host at /home/woi/.local
ENV PATH="/home/woi/.local/bin:${PATH}"

COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node . .
RUN chmod -R a+rX /home/node/app

# Expose port
EXPOSE 3005

# Start the application
CMD ["node", "server.js"]
