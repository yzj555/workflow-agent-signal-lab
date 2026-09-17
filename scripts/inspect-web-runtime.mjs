/** Passive discovery of native web read routes; no prompt, selection or command is sent. */
import { chromium } from 'file:///F:/dsh/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const requests = []
  page.on('request', request => {
    if (request.method() !== 'POST') return
    try {
      const body = request.postDataJSON()
      requests.push({ path: new URL(request.url()).pathname, keys: Object.keys(body),
        route: body.method ?? body.methodName ?? body.path ?? null,
        addressing: Object.fromEntries(Object.entries(body).filter(([key]) => ['kind', 'type', 'target', 'scope', 'namespace', 'member', 'service'].includes(key))),
      })
    } catch { /* Only native JSON RPC metadata is relevant. */ }
  })
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20000 })
  console.log(JSON.stringify({ requests, text: await page.locator('body').innerText() }, null, 2))
} finally { await browser.close() }
