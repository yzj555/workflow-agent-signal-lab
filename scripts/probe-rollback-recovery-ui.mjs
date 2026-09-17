/** Candidate client + recorded isolated snapshots in throwaway native DSH pages.
 * Explicit browser-only replay, not deployment and not an online rollback test.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [coreRoot, launchLog, outputRoot] = process.argv.slice(2)
assert.ok(coreRoot && launchLog && outputRoot)
const root = resolve(import.meta.dirname, '..'), output = resolve(outputRoot)
const base = join(root, '.dsh/activation/workflow-rollback-recovery-20260917')
await mkdir(output)
const url = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const normalize = code => code.replace(/\r\n/gu, '\n').split('//# sourceMappingURL=')[0].trim()
const old = normalize(await readFile(join(root, 'lib/client.js'), 'utf8'))
const candidate = normalize(await readFile(join(base, 'candidate/lib/client.js'), 'utf8'))
assert.notEqual(candidate, old)
const sample = JSON.parse(await readFile(join(base, 'cuts-v1/cases/rollback-backed.json'), 'utf8'))
const applied = JSON.parse(await readFile(join(base, 'cuts-v1/cases/rollback-applied.json'), 'utf8'))
const cases = [
  { name: 'interrupted', badge: '撤销未完成', snapshot: sample.phases.find(p => p.phase === 'first-cold').snapshot },
  { name: 'committed-cleanup', badge: '已撤销 · 待清理', snapshot: applied.phases.find(p => p.phase === 'before-kill').snapshot },
]
const targetId = 'workflow-production-l1-clean-pass-20260911-1810'
const targetTitle = 'Production Gate · Clean L1 端口快照增强'
const { chromium } = await import(pathToFileURL(join(resolve(coreRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const browser = await chromium.launch({ headless: true })
const report = { startedAt: new Date().toISOString(), readonly: true, candidateInjected: 0, snapshotsReplayed: 0,
  deployed: false, errors: [], blockedWrites: [], checks: [], phase: 'open' }
try {
  for (const target of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => report.errors.push(error.message))
    await page.route('**/*', async route => {
      const request = route.request(), parsed = new URL(request.url()), path = parsed.pathname
      if (path.startsWith('/api/')) {
        const method = path.slice(5).replaceAll('.', '/')
        if (/^(respond|\$events\/result|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt|interruptByParent)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(run|execute))$/u.test(method)) {
          report.blockedWrites.push(method); return route.abort('blockedbyclient')
        }
      }
      if (path === '/workflow-runtime/snapshot') {
        const rpc = request.postDataJSON(), value = structuredClone(target.snapshot)
        assert.equal(rpc.payload.rootSessionId, targetId)
        value.rootSessionId = targetId
        value.run.title = '【隔离证据回放 · 非当前运行】' + value.run.title
        report.snapshotsReplayed++
        return route.fulfill({ json: { type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } } })
      }
      if (request.resourceType() === 'script' && parsed.origin === 'http://127.0.0.1:3080') {
        const response = await route.fetch(), body = (await response.text()).replace(/\r\n/gu, '\n')
        if (body.includes('id: "@local/workflow-agent-signal-lab"')) {
          assert.equal(body.split(old).length, 2, 'Only the expected live plugin client may be replaced in this throwaway page')
          report.candidateInjected++
          // A replacement callback keeps literal $&/$`/$' inside JS untouched.
          return route.fulfill({ response, body: body.replace(old, () => candidate) })
        }
        return route.fulfill({ response, body })
      }
      return route.continue()
    })
    assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })).status(), 200)
    report.phase = 'native-shell'
    await page.waitForFunction(() => document.querySelectorAll('button').length > 5, undefined, { timeout: 20000 })
    const search = page.getByRole('button', { name: '搜索会话', exact: true })
    if (!await search.isVisible().catch(() => false)) await page.locator('button[aria-label="展开侧边栏"],button[title="侧边对话(beta)"]').first().click()
    await search.click(); await page.getByPlaceholder('搜索会话…', { exact: true }).fill(targetTitle)
    await page.getByText(targetTitle, { exact: true }).first().click()
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: '工作流', exact: true }).click()
    report.phase = 'workflow-view'
    const view = page.locator('.wfr-view')
    await page.waitForFunction(badge => document.querySelector('.wfr-view')?.textContent?.includes(badge), target.badge, { timeout: 15000 })
    assert.equal(await page.locator('.wfr-status[data-placement=header]').innerText(), target.badge)
    assert.match(await view.innerText(), /原交付与验收结论仅保留为历史/)
    assert.match(await view.locator('.wfr-step').nth(5).innerText(), new RegExp(target.badge))
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1050 })
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      const geometry = await view.evaluate(node => ({ overflow: node.scrollWidth > node.clientWidth,
        rowOverflow: [...node.querySelectorAll('.wfr-agent')].some(row => row.scrollWidth > row.clientWidth),
        pluginInputs: node.querySelectorAll('input,textarea,[contenteditable=true]').length,
        nativeInputs: document.querySelectorAll('textarea,[contenteditable=true]').length }))
      assert.equal(geometry.overflow, false); assert.equal(geometry.rowOverflow, false)
      assert.equal(geometry.pluginInputs, 0); assert.equal(geometry.nativeInputs, 1)
      await page.evaluate(() => {
        let node = document.querySelector('.wfr-view')
        while (node) { if (node.scrollHeight > node.clientHeight) node.scrollTop = 0; node = node.parentElement }
      })
      await page.screenshot({ path: join(output, `${target.name}-${width}.png`), fullPage: true })
      report.checks.push({ name: target.name, width, badge: target.badge, ...geometry })
    }
    await page.close()
  }
  assert.equal(report.errors.length, 0); assert.equal(report.blockedWrites.length, 0)
  assert.ok(report.candidateInjected >= 2); assert.ok(report.snapshotsReplayed >= 2)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error).replaceAll(url, 'http://127.0.0.1:3080/[auth-redacted]'); process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  await browser.close()
  console.log(JSON.stringify({ status: report.status, error: report.error, checks: report.checks.length,
    candidateInjected: report.candidateInjected, blockedWrites: report.blockedWrites, errors: report.errors }))
}
