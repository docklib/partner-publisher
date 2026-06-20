/**
 * push-to-cdn.mjs
 *
 * Pushes the built `dist/partner-{staticId}.js` to docklib/v2@master at path
 * `partner-{staticId}.js` (repo root — the repo name already says v2, no subfolder) via the
 * GitHub contents API. Atomic, one file, no clone, no rebase conflicts. Prints the commit SHA.
 *
 * Runs with CWD = the builder repo (partner/), so `dist/` is the builder's dist dir.
 *
 * Env:
 *   CDN_REPO_PAT   fine-grained PAT with Contents: Read & Write on docklib/v2
 *   STATIC_ID      partner static id (sha256(configName)[:8])
 */
import { readFileSync } from 'node:fs'

const staticId = process.env.STATIC_ID
const token = process.env.CDN_REPO_PAT
if (!staticId || !token) {
  console.error('push-to-cdn: STATIC_ID and CDN_REPO_PAT are required')
  process.exit(1)
}

const owner = 'docklib'
const repo = 'v2'
const branch = 'master'
const path = `partner-${staticId}.js`
const localFile = `dist/partner-${staticId}.js`

let content
try {
  content = readFileSync(localFile).toString('base64')
} catch (e) {
  console.error(`push-to-cdn: could not read ${localFile} — did vite build run?`, e.message)
  process.exit(1)
}

const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

// 1. Look up the current file SHA (required for update; omit for create).
console.log(`push-to-cdn: looking up ${owner}/${repo}/${path}@${branch}`)
const head = await fetch(`${apiBase}/${encodeURIComponent(path)}?ref=${branch}`, { headers })
let sha = null
if (head.status === 200) {
  sha = (await head.json()).sha
  console.log(`push-to-cdn: existing file sha=${sha} — will update`)
} else if (head.status === 404) {
  console.log('push-to-cdn: file does not exist yet — will create')
} else {
  console.error(`push-to-cdn: lookup failed ${head.status} ${await head.text()}`)
  process.exit(1)
}

// 2. Put the file.
const put = await fetch(`${apiBase}/${encodeURIComponent(path)}`, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: `publish v2 ${staticId} ${new Date().toISOString()}`,
    content,
    sha,
    branch,
  }),
})
if (!put.ok) {
  console.error(`push-to-cdn: put failed ${put.status} ${await put.text()}`)
  process.exit(1)
}
const body = await put.json()
console.log(`push-to-cdn: committed ${path} @ ${body.commit.sha}`)

// Emit the commit sha as a step output for the workflow (and for the dashboard to record).
const fs = await import('node:fs')
fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null', `cdn_commit_sha=${body.commit.sha}\n`)
fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/null', `commit_sha=${body.commit.sha}\n`)
