/**
 * report-result.mjs <success|failed> [message]
 *
 * Reports the build/push outcome back to the dashboard so the `partner_publishes` row flips
 * from `building` → `success`/`failed` and records the cdn_commit_sha + github_run_id.
 *
 * Env:
 *   DASHBOARD_CONFIG_URL
 *   DASHBOARD_CONFIG_TOKEN
 *   PUBLISH_ID         the dashboard publish row id (from resolve-target)
 *   CDN_COMMIT_SHA     optional, only on success (from push-to-cdn.mjs step output)
 *   GITHUB_RUN_ID      optional, the Actions run id
 */
const [status, message] = process.argv.slice(2)
if (status !== 'success' && status !== 'failed') {
  console.error('Usage: report-result.mjs <success|failed> [message]')
  process.exit(1)
}

const base = (process.env.DASHBOARD_CONFIG_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_CONFIG_TOKEN
const publishId = process.env.PUBLISH_ID
if (!base || !token || !publishId) {
  console.error('report-result: DASHBOARD_CONFIG_URL, DASHBOARD_CONFIG_TOKEN, PUBLISH_ID are required')
  process.exit(1)
}

const payload = {
  status,
  cdn_commit_sha: process.env.CDN_COMMIT_SHA || null,
  github_run_id: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
  message: message || null,
}

const url = `${base}/api/admin/publishes/${publishId}/result`
console.log(`report-result: POST ${url} status=${status}`)
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
if (!res.ok) {
  console.error(`report-result: failed ${res.status} ${await res.text()}`)
  process.exit(1)
}
console.log(`report-result: ok (${status})`)
