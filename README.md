# just-buy-it

Find the deal, skip the scam, just buy it.

A deal monitor for used PC hardware on eBay.de. It watches listings for GPUs (RTX 3090/4090 first), DDR4/DDR5 RAM and gaming PCs, compares each price with a fair value, screens the listing for common scams with Claude, and sends an email alert. A person always makes the purchase through eBay's own checkout; the tool never buys, bids or messages sellers.

## Status

Early, Phase 0. What runs today:

- The server answers eBay's marketplace account deletion notifications (challenge, signature check, acknowledgement), which eBay requires before it enables a production keyset.
- A live Browse API search on EBAY_DE works with the production keyset.

Search, pricing, screening and alerts come next. The plan, decisions, ADRs and phase plans are in [`docs/`](docs/README.md).

## Layout

- `apps/server`: Hono server with the deletion endpoint, `/healthz` and `/privacy`
- `infra/`: Dockerfile, Compose file and a Traefik route for a shared Docker host
- `docs/`: planning, decision register, ADRs, phase plans

## Requirements

- Node 24 and pnpm 12 (`npx pnpm@12.12.1`)
- An eBay developer account with a production keyset (App ID and Cert ID)
- A public HTTPS URL for the deletion endpoint

## Local checks

```sh
npx pnpm@12.12.1 install
pnpm turbo run lint typecheck test --affected
pnpm turbo run lint typecheck test --filter=@ebay-sniper/server
pnpm depcruise
```

## Configuration

Copy `.env.example` and fill in the values. On a server, keep the file readable by root only (mode 600) and never commit it.

| Variable | Meaning |
| --- | --- |
| `EBAY_ENVIRONMENT` | `production` or `sandbox` |
| `EBAY_DELETION_ENDPOINT_URL` | Public HTTPS URL of `/ebay/account-deletion`, exactly as entered in the eBay portal |
| `EBAY_DELETION_VERIFICATION_TOKEN` | 32 to 80 characters of `[A-Za-z0-9_-]`, e.g. `openssl rand -hex 32` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | App ID and Cert ID of the keyset, used to fetch eBay's signing keys |

## Deploy

The Compose file publishes the container on `127.0.0.1:3140` and expects a reverse proxy in front. `infra/traefik/ebay-sniper.yml` is a Traefik file-provider route; change the host name to your own domain.

```sh
rsync -az --delete --exclude node_modules --exclude dist --exclude .git --exclude .claude ./ <host>:/opt/ebay-sniper/src/
ssh <host> 'cd /opt/ebay-sniper/src && docker compose -f infra/docker-compose.yml up -d --build'
ssh <host> 'cp /opt/ebay-sniper/src/infra/traefik/ebay-sniper.yml /opt/traefik/dynamic/ebay-sniper.yml'
curl -s https://<your-domain>/healthz
```

Then subscribe the endpoint in the eBay developer portal (Application Keys, Notifications, Marketplace Account Deletion) with the same URL and token, and send a test notification. The server log should show `"verified":true`.

## eBay terms

This project is not affiliated with or endorsed by eBay. Anyone running it is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## License

[MIT](LICENSE)
