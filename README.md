# boxy

> A GitHub App built with [Probot](https://github.com/probot/probot) that our assistant for our Spelling Creator repos

## Setup

```sh
# Install dependencies
pnpm install

# Run the bot
pnpm start
```

## Docker

```sh
# 1. Build container
docker build -t boxy .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> boxy
```

## Contributing

If you have suggestions for how boxy could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[GPL-3.0](LICENSE) © 2026 supervoidcoder

This fork contains modifications by the Spelling Creator authors.