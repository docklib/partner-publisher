/**
 * fetch-config.mjs <configName> <staticId>
 *
 * Pulls a partner's widget config from the dashboard (single source of truth) and writes
 * `src/config.{configName}.js` into the private builder checkout. This is the ONE bridge
 * between D1 and the build: dashboard -> generateWidgetConfigSource -> this file -> vite.
 *
 * Runs with CWD = the builder repo (partner/), so `src/` is the builder's src dir.
 *
 * Env:
 *   DASHBOARD_CONFIG_URL   e.g. https://publisher.senty.com.au
 *   DASHBOARD_CONFIG_TOKEN bearer token the dashboard checks on /api/widget-config-export/*
 *
 * Dashboard contract: GET {URL}/api/widget-config-export/{staticId}?name={configName}
 *   -> 200 { source: string, configHash: string, configName: string, staticId: string }
 *   -> 404 if no widget config linked for this staticId
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [configName, staticId] = process.argv.slice(2)
if (!configName || !staticId) {
  console.error('Usage: fetch-config.mjs <configName> <staticId>')
  process.exit(1)
}

const base = (process.env.DASHBOARD_CONFIG_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_CONFIG_TOKEN
if (!base || !token) {
  console.error('fetch-config: DASHBOARD_CONFIG_URL and DASHBOARD_CONFIG_TOKEN are required')
  process.exit(1)
}

const url = `${base}/api/widget-config-export/${encodeURIComponent(staticId)}?name=${encodeURIComponent(configName)}`
console.log(`fetch-config: GET ${url}`)

const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
if (!res.ok) {
  console.error(`fetch-config: ${res.status} ${await res.text()}`)
  process.exit(1)
}

const body = await res.json()

if (body.configName !== configName || body.staticId !== staticId) {
  console.error(
    `fetch-config: mismatch — requested ${configName}/${staticId}, got ${body.configName}/${body.staticId}`
  )
  process.exit(1)
}

// build-partner.js reads src/config.{name}.js and copies it to src/config.js before vite build.
mkdirSync('src', { recursive: true })
const outPath = join('src', `config.${configName}.js`)
writeFileSync(outPath, body.source)
console.log(`fetch-config: wrote ${outPath} (${body.source.length} bytes, hash=${body.configHash.slice(0, 12)})`)
