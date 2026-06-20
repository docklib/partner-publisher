/**
 * resolve-target.mjs
 *
 * Decides what this workflow run should build. Two modes:
 *
 *   (a) Scheduled run, or manual run with no inputs → claim the oldest `queued` row from the
 *       dashboard's `partner_publishes` table by calling
 *       `GET /api/admin/publish-queue?claim=1`. The dashboard atomically flips it
 *       `queued → building` so two concurrent pollers can't grab the same row.
 *   (b) Manual run with explicit static_id + config_name inputs → build that partner directly
 *       without touching the queue (ad-hoc rebuild; no audit row).
 *
 * Emits GITHUB_OUTPUT lines:
 *   publish_id=<id or empty>
 *   static_id=<...>
 *   config_name=<...>
 *
 * When publish_id is empty, the workflow's "Skip when queue is empty" step exits 0 and all
 * subsequent steps are gated off with `if: steps.target.outputs.publish_id != ''`.
 */
const manualStaticId = process.env.MANUAL_STATIC_ID?.trim()
const manualConfigName = process.env.MANUAL_CONFIG_NAME?.trim()
const base = (process.env.DASHBOARD_CONFIG_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_CONFIG_TOKEN
const out = (k, v) => console.log(`${k}=${v ?? ''}`)

if (!base || !token) {
  console.error('resolve-target: DASHBOARD_CONFIG_URL and DASHBOARD_CONFIG_TOKEN are required')
  process.exit(1)
}

// Mode (b): explicit manual inputs — build that partner directly, no queue row.
if (manualStaticId && manualConfigName) {
  out('publish_id', '')
  out('static_id', manualStaticId)
  out('config_name', manualConfigName)
  console.error(`resolve-target: manual build for ${manualConfigName}/${manualStaticId} (no queue row)`)
  process.exit(0)
}

// Mode (a): claim a queued row.
const url = `${base}/api/admin/publish-queue?claim=1`
console.error(`resolve-target: GET ${url}`)
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
if (!res.ok) {
  console.error(`resolve-target: claim failed ${res.status} ${await res.text()}`)
  process.exit(1)
}
const body = await res.json()

if (!body.publish) {
  out('publish_id', '')
  out('static_id', '')
  out('config_name', '')
  console.error('resolve-target: queue empty')
  process.exit(0)
}

const p = body.publish
if (!p.config_name || !p.static_id) {
  console.error(`resolve-target: queued row ${p.id} missing config_name/static_id — reporting failure`)
  // Best-effort: report failure so the row doesn't stick in `building` forever.
  try {
    await fetch(`${base}/api/admin/publishes/${p.id}/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed', message: 'queued row missing config_name/static_id' }),
    })
  } catch {
    /* ignore */
  }
  process.exit(1)
}

out('publish_id', p.id)
out('static_id', p.static_id)
out('config_name', p.config_name)
console.error(`resolve-target: claimed publish #${p.id} for ${p.config_name}/${p.static_id}`)
