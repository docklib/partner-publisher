/**
 * invalidate-cache.mjs <staticId>
 *
 * Scoped jsDelivr purge of exactly one file:
 *   https://cdn.jsdelivr.net/gh/docklib/v2@master/partner-{staticId}.js
 *
 * jsDelivr's purge API takes RELATIVE paths ("/gh/docklib/v2@master/..."), NOT full URLs —
 * sending a full URL makes the purge "finish" but not actually invalidate the edge cache
 * (the path key in the response comes back prefixed with "/https://...", a tell). This was
 * bug #7b in PARTNER_PUBLISH_V2.md.
 */
const [staticId] = process.argv.slice(2)
if (!staticId) {
  console.error('Usage: invalidate-cache.mjs <staticId>')
  process.exit(1)
}

// Relative path is what jsDelivr actually purges; the full URL is just for logging.
const relativePath = `/gh/docklib/v2@master/partner-${staticId}.js`
const fullUrl = `https://cdn.jsdelivr.net${relativePath}`
console.error(`invalidate-cache: purging ${relativePath}`)

const res = await fetch('https://purge.jsdelivr.net/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: [relativePath] }),
})
const out = await res.json()
if (!res.ok) {
  console.error(`invalidate-cache: failed ${res.status}`, out)
  process.exit(1)
}
console.error(`invalidate-cache: purge ${out.status} (id=${out.id}) → ${fullUrl}`)
