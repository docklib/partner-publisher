/**
 * drain-queue.mjs
 *
 * Drains the entire dashboard publish queue in ONE GitHub Actions run. Loops:
 *   claim a queued row (GET /api/admin/publish-queue?claim=1)
 *     → if null, queue empty, stop
 *   fetch config (GET /api/widget-config-export/{staticId})
 *   write src/config.{name}.js
 *   vite build via build-partner.js <name> v2
 *   push dist/partner-{staticId}.js to docklib/v2@master (GitHub contents API)
 *   purge jsDelivr (relative path; continue-on-error)
 *   report success/failed back to the dashboard
 *   repeat
 *
 * Each iteration is wrapped in try/catch so one partner's failure doesn't stop the
 * drain — the failed row is reported and the loop continues with the next claim.
 *
 * Manual single-partner mode: if MANUAL_STATIC_ID + MANUAL_CONFIG_NAME env vars are set,
 * build just that partner directly (no claim, no audit row) and exit.
 *
 * CWD = the builder repo (partner/). Publisher scripts are at ../publisher/scripts/.
 * Env: DASHBOARD_CONFIG_URL, DASHBOARD_CONFIG_TOKEN, CDN_REPO_PAT, GITHUB_RUN_ID,
 *      MANUAL_STATIC_ID?, MANUAL_CONFIG_NAME?
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = (process.env.DASHBOARD_CONFIG_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_CONFIG_TOKEN
const cdnToken = process.env.CDN_REPO_PAT
const runId = process.env.GITHUB_RUN_ID || null
const manualStaticId = process.env.MANUAL_STATIC_ID?.trim()
const manualConfigName = process.env.MANUAL_CONFIG_NAME?.trim()

if (!base || !token) {
  console.error('drain-queue: DASHBOARD_CONFIG_URL and DASHBOARD_CONFIG_TOKEN are required')
  process.exit(1)
}
if (!cdnToken) {
  console.error('drain-queue: CDN_REPO_PAT is required')
  process.exit(1)
}

const authHeaders = { Authorization: `Bearer ${token}` }
const ghApiBase = 'https://api.github.com/repos/docklib/v2/contents'
const ghHeaders = {
  Authorization: `Bearer ${cdnToken}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function claimRow() {
  const res = await fetch(`${base}/api/admin/publish-queue?claim=1`, { headers: authHeaders })
  if (!res.ok) throw new Error(`claim failed ${res.status} ${await res.text()}`)
  const body = await res.json()
  return body.publish ?? null
}

async function fetchConfig(configName, staticId) {
  const url = `${base}/api/widget-config-export/${encodeURIComponent(staticId)}?name=${encodeURIComponent(configName)}`
  const res = await fetch(url, { headers: authHeaders })
  if (!res.ok) throw new Error(`fetch-config ${res.status} ${await res.text()}`)
  const body = await res.json()
  if (body.configName !== configName || body.staticId !== staticId) {
    throw new Error(`config mismatch: requested ${configName}/${staticId}, got ${body.configName}/${body.staticId}`)
  }
  return body.source
}

function buildPartner(configName) {
  // build-partner.js copies src/config.{name}.js → src/config.js, runs vite, renames to partner-{staticId}.js.
  // Use v2 mode (entry src/v2-main.js with data-w-* support).
  execFileSync('node', ['build-partner.js', configName, 'v2'], { stdio: 'inherit' })
}

async function pushToCdn(staticId) {
  const path = `partner-${staticId}.js`
  const localFile = `dist/partner-${staticId}.js`
  if (!existsSync(localFile)) throw new Error(`missing ${localFile} — vite build did not produce it`)
  const content = readFileSync(localFile).toString('base64')

  const head = await fetch(`${ghApiBase}/${encodeURIComponent(path)}?ref=master`, { headers: ghHeaders })
  let sha = null
  if (head.status === 200) sha = (await head.json()).sha
  else if (head.status !== 404) throw new Error(`cdn lookup ${head.status} ${await head.text()}`)

  const put = await fetch(`${ghApiBase}/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `publish v2 ${staticId} ${new Date().toISOString()}`,
      content,
      sha,
      branch: 'master',
    }),
  })
  if (!put.ok) throw new Error(`cdn put ${put.status} ${await put.text()}`)
  const body = await put.json()
  return body.commit.sha
}

async function purgeCdn(staticId) {
  // Relative path — jsDelivr's purge API takes paths, not full URLs (bug #7b).
  const relativePath = `/gh/docklib/v2@master/partner-${staticId}.js`
  try {
    const res = await fetch('https://purge.jsdelivr.net/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: [relativePath] }),
    })
    if (!res.ok) console.error(`drain-queue: purge ${staticId} failed ${res.status} (non-fatal)`)
  } catch (e) {
    console.error(`drain-queue: purge ${staticId} error (non-fatal): ${e.message}`)
  }
}

async function reportResult(publishId, status, { cdnCommitSha, message } = {}) {
  if (!publishId) return // manual mode has no audit row
  try {
    await fetch(`${base}/api/admin/publishes/${publishId}/result`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        cdn_commit_sha: cdnCommitSha || null,
        github_run_id: runId ? Number(runId) : null,
        message: message || null,
      }),
    })
  } catch (e) {
    console.error(`drain-queue: report ${publishId} failed (non-fatal): ${e.message}`)
  }
}

async function processOne({ id, config_name, static_id }) {
  if (!config_name || !static_id) throw new Error('queued row missing config_name/static_id')
  console.log(`\n=== publish #${id}: ${config_name}/${static_id} ===`)
  const source = await fetchConfig(config_name, static_id)
  mkdirSync('src', { recursive: true })
  writeFileSync(join('src', `config.${config_name}.js`), source)
  buildPartner(config_name)
  const cdnCommitSha = await pushToCdn(static_id)
  await purgeCdn(static_id)
  return cdnCommitSha
}

// ---- Manual single-partner mode (no claim, no audit row) ----
if (manualStaticId && manualConfigName) {
  console.log(`drain-queue: manual build ${manualConfigName}/${manualStaticId} (no audit row)`)
  try {
    const source = await fetchConfig(manualConfigName, manualStaticId)
    mkdirSync('src', { recursive: true })
    writeFileSync(join('src', `config.${manualConfigName}.js`), source)
    buildPartner(manualConfigName)
    const sha = await pushToCdn(manualStaticId)
    await purgeCdn(manualStaticId)
    console.log(`drain-queue: done, commit ${sha}`)
    process.exit(0)
  } catch (e) {
    console.error(`drain-queue: manual build failed: ${e.message}`)
    process.exit(1)
  }
}

// ---- Queue-drain mode ----
let processed = 0
let successes = 0
let failures = 0
const start = Date.now()

while (true) {
  let row
  try {
    row = await claimRow()
  } catch (e) {
    console.error(`drain-queue: claim error, stopping: ${e.message}`)
    break
  }
  if (!row) {
    console.log('drain-queue: queue empty')
    break
  }

  processed++
  try {
    const cdnCommitSha = await processOne(row)
    await reportResult(row.id, 'success', { cdnCommitSha })
    successes++
    console.log(`✓ #${row.id} ${row.partner_key} → ${cdnCommitSha.slice(0, 12)}`)
  } catch (e) {
    failures++
    console.error(`✗ #${row.id} ${row.partner_key}: ${e.message}`)
    await reportResult(row.id, 'failed', { message: e.message.slice(0, 240) })
    // continue to next row
  }
}

const elapsed = Math.round((Date.now() - start) / 1000)
console.log(
  `\ndrain-queue: done — processed ${processed}, success ${successes}, failed ${failures}, ${elapsed}s`
)
