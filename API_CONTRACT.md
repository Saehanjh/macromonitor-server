# MacroMonitor server API contract

All routes return JSON. Successful cached routes may include `source` (`fresh`,
`cache`, `stale`, `live`, `partial`, or `dummy`) and `X-Cache`. A client in
server mode must treat `source: "dummy"` as unavailable live data.

## Public routes

- `GET /health`
- `GET /api/fred/:seriesId?start&end&limit&sort`
- `GET /api/yahoo/:symbol?interval&range`
- `GET /api/coingecko/{simple/price,coins/markets,coins/:id/market_chart,global}`
- `GET /api/defillama/{stablecoins,stablecoincharts/all,tvl/:protocol,protocols}`
- `GET /api/news?category&window`, `GET /api/calendar?date`
- `GET /api/economy/{commodities,inflation,expectations,corporate,labor,consumer}`
- `GET /api/global/{dollar,factory,demand}?range`
- `GET /api/onchain/{stablecoins?days,rwa,btc-etf}`
- `GET /api/treasury/{auctions?days,plumbing}`
- `GET /api/markets/{volatility,plumbing,history/:metric?range,capital-migration,sectors,leverage,liquidity-flow,mmf-deposits,repo-phase,rates?range,credit}`
- `POST /api/push/{register,unregister}` with `{ "token": "ExponentPushToken[...]" }`

Errors have the form `{ "error": string, "message": string }`; upstream
errors also include `upstreamStatus`. `429` includes `Retry-After`.

## Environment and CORS

Keep `FRED_API_KEY` and `ADMIN_TOKEN` only in the server environment. Set
`CORS_ORIGIN` to a comma-separated browser allow-list in production (for
example `https://app.example.com`). Expo native apps call the configured base
URL directly; Metro has no Vite proxy. For a physical phone, use the computer's
LAN address in the Expo app's `EXPO_PUBLIC_API_BASE_URL`.
