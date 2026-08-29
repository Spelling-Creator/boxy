FROM node:20-slim
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client sshpass && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod
RUN pnpm store prune
ENV NODE_ENV="production"
COPY . .
CMD [ "pnpm", "start" ]
