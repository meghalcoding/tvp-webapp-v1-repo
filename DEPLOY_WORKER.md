# Deploy the live Cloudflare Worker

The production URL is a Cloudflare **Worker** (`tvp-finapp.meghalcoding.workers.dev`),
not a Cloudflare Pages deployment. A Git push updates GitHub only; it does not replace
the Worker's static asset bundle unless Workers Builds has been configured separately.

From this folder, deploy the current application assets with Wrangler:

```powershell
npx wrangler login
npx wrangler deploy
```

The checked-in `wrangler.jsonc` deploys this folder as the static asset directory for
the existing `tvp-finapp` Worker. After deployment, verify these URLs return JavaScript
rather than a 404 or stale source:

- `/js/daily-operations.js`
- `/js/procurement-inventory.js`
- `/js/reporting.js`

If you want Cloudflare to deploy on every GitHub push, configure Workers Builds for
this repository and use `npx wrangler deploy` as its deploy command.
