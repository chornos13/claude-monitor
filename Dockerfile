FROM node:20-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Install uv (for claude-swap)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /home/node/app
RUN chown node:node /home/node/app

USER node

RUN uv tool install claude-swap==0.8.1

# Ensure tools are in the PATH
ENV PATH="/home/node/.local/bin:${PATH}"

COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node . .
RUN chmod -R a+rX /home/node/app

# Expose port
EXPOSE 3005

# Start the application
CMD ["node", "server.js"]
