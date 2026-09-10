# MacroMonitor server API contract

All routes return JSON. Successful cached routes may include `source` (`fresh`,
`cache`, `stale`, `live`, `partial`, or `dummy`) and `X-Cache`. A client in
server mode must treat `source: "dummy"` as unavailable live data.

## Public routes

- `GET /health` (includes `apiVersion` and `capabilities`; use it to verify a deployed backend)
- `GET /api/fred/:seriesId?start&end&limit&sort`
- `GET /api/yahoo/:symbol?interval&range`
- `GET /api/yahoo?symbols=NVDA,005930.KS&interval&range` (preferred mobile batch endpoint; at most 30 symbols)
- `GET /api/coingecko/{simple/price,coins/markets,coins/:id/market_chart,global}`
- `GET /api/defillama/{stablecoins,stablecoincharts/all,tvl/:protocol,protocols}`
- `GET /api/news?category&window`, `GET /api/calendar?date`
- `GET /api/economy/{commodities,inflation,expectations,corporate,labor,consumer}`
- `GET /api/global/{dollar,factory,demand}?range`
- `GET /api/onchain/{stablecoins?days,rwa,btc-etf}`
- `GET /api/treasury/{auctions?days,plumbing}`
- `GET /api/markets/{volatility,plumbing,history/:metric?range,capital-migration,sectors,leverage,liquidity-flow,mmf-deposits,repo-phase,rates?range,credit}`
- `POST /api/push/{register,unregister}` with `{ "token": "ExponentPushToken[...]" }`

## Personal read model (Phase C)

`POST /api/personal/v1/session` accepts a random per-install `deviceId` and returns
an opaque, signed session token. The signing secret stays in Render as
`PERSONAL_SESSION_SECRET`; the mobile app stores only its own session token and
never contains `PERSONAL_API_TOKEN` or a Supabase key. Other routes accept the
returned token in `Authorization: Bearer ...` or `X-Personal-Token`. They derive
the owner on the server; no owner id from the request body is trusted. For local development only, set
`PERSONAL_API_ALLOW_LOCAL=true` and send `X-Owner-Id`.

- `GET /api/personal/v1/instruments/search?q=` and `POST /instruments`
- `GET/POST/DELETE /watchlist`, `GET/POST/DELETE /holdings`
- `GET /snapshots/latest`, `GET /briefings`
- `GET/POST/PATCH/DELETE /trackers` (종목별 이벤트 추적 규칙)
- `GET /events`, `PATCH /events/:id/review` (근거 차이와 사용자 확인 상태)
- `GET/POST/PATCH/DELETE /notes` (투자 근거와 `evidenceIds` 연결)
- `POST /briefing-jobs` with an `Idempotency-Key` (8–200 chars),
  `GET /briefing-jobs/:id`

Snapshots are written by the Python worker through `POST /snapshots` with the
per-process `x-internal-secret`; that route is never usable from the mobile app.
Quote snapshots carry `source`, `fetchedAt`, `asOf`, and `status`. A snapshot's
`coverage.status` is `partial` when any requested source or instrument failed;
clients must not calculate a complete portfolio return from a partial snapshot.
The default local persistence is a small JSON read model at `data/personal-store.json`.
Set `PERSONAL_STORE_PATH` to a durable volume in production.

Errors have the form `{ "error": string, "message": string }`; upstream
errors also include `upstreamStatus`. `429` includes `Retry-After`.

## Environment and CORS

Keep `FRED_API_KEY` and `ADMIN_TOKEN` only in the server environment. Set
`CORS_ORIGIN` to a comma-separated browser allow-list in production (for
example `https://app.example.com`). Expo native apps call the configured base
URL directly; Metro has no Vite proxy. For a physical phone, use the computer's
LAN address in the Expo app's `EXPO_PUBLIC_API_BASE_URL`.
