/** Real 3080 read-only UI verification; never injects a snapshot or answers a gate. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [coreRoot, launchLog, outputRoot] = process.argv.slice(2)
assert.ok(coreRoot && launchLog && outputRoot)
const output = resolve(outputRoot)
await mkdir(output)
const url = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const candidate = (await readFile('lib/client.js', 'utf8')).replace(/\r\n/gu, '\n').split('//# sourceMappingURL=')[0].trim()
const { chromium } = await import(pathToFileURL(join(resolve(coreRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const browser = await chromium.launch({ headless: true })
const report = { startedAt: new Date().toISOString(), readonly: true, snapshotInjection: false,
  candidateServed: 0, errors: [], blockedWrites: [], failedRequests: [], checks: [] }
const cases = [
  { name: 'command-ended', id: 'workflow-budget-command-online-20260917', title: '整轮预算验收 · 命令额度', revision: 44, kind: 'ended' },
  { name: 'time-ended', id: 'workflow-budget-time-online-20260917', title: '整轮预算验收 · 累计时长', revision: 49, kind: 'ended' },
  { name: 'protected-unknown', id: 'workflow-command-online-restart-v3-20260915', title: '命令监管验收 · 重启后未知 v3', revision: 35, kind: 'unknown' },
  { name: 'protected-pass', id: 'workflow-production-l1-clean-pass-20260911-1810', title: 'Production Gate · Clean L1 端口快照增强', revision: 126, kind: 'pass' },
]
try {
  for (const target of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
    const beforeServed = report.candidateServed
    page.on('pageerror', error => report.errors.push(error.message))
    page.on('requestfailed', request => {
      const path = new URL(request.url()).pathname, error = request.failure()?.errorText
      if (path === '/api/session/search' && error === 'net::ERR_ABORTED') return
      report.failedRequests.push({ path, error })
    })
    await page.route('**/*', async route => {
      const request = route.request(), parsed = new URL(request.url()), path = parsed.pathname
      if (path.startsWith('/api/')) {
        const method = path.slice(5).replaceAll('.', '/')
        if (/^(respond|\$events\/result|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt|interruptByParent)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(run|execute))$/u.test(method)) {
          report.blockedWrites.push(method); return route.abort('blockedbyclient')
        }
      }
      if (request.resourceType() === 'script' && parsed.origin === 'http://127.0.0.1:3080') {
        const response = await route.fetch(), body = await response.text()
        if (body.includes('id: "@local/workflow-agent-signal-lab"')) {
          assert.ok(body.replace(/\r\n/gu, '\n').includes(candidate), '3080 served an old client build')
          report.candidateServed++
        }
        return route.fulfill({ response, body }) // Unmodified response, no UI bridge or replacement.
      }
      return route.continue()
    })
    assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })).status(), 200)
    await page.waitForFunction(() => document.querySelectorAll('button').length > 5, undefined, { timeout: 20000 })
    let search = page.getByRole('button', { name: '搜索会话', exact: true })
    if (!await search.isVisible().catch(() => false)) {
      await page.locator('button[aria-label="展开侧边栏"],button[title="侧边对话(beta)"]').first().click()
      await search.waitFor({ state: 'visible' })
    }
    await search.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(target.title)
    await page.getByText(target.title, { exact: true }).first().click()
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: '工作流', exact: true }).click()
    await page.waitForFunction(revision => document.querySelector('.wfr-view')?.textContent?.includes(`revision ${revision}`), target.revision)
    const snapshot = await page.evaluate(async id => {
      const rpcId = crypto.randomUUID(), response = await fetch('/workflow-runtime/snapshot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'snapshot', payload: { schemaVersion: 1, rootSessionId: id } }),
      })
      const envelope = await response.json()
      if (!response.ok || envelope.rpcId !== rpcId || !envelope.result.ok) throw Error('Read-only snapshot rejected')
      return envelope.result.value
    }, target.id)
    assert.equal(snapshot.rootSessionId, target.id); assert.equal(snapshot.revision, target.revision)
    assert.ok(report.candidateServed > beforeServed)
    await writeFile(join(output, `${target.name}-snapshot.json`), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
    const view = page.locator('.wfr-view'), rows = view.locator('.wfr-agent'), history = view.locator('.wfr-agent-history-disclosure')
    const statuses = await view.locator('.wfr-agent-status').allTextContents()
    assert.equal(await rows.count(), snapshot.run.agents.length)
    if (target.kind === 'ended') {
      assert.equal(snapshot.run.outcome, 'CANCELLED')
      assert.equal(await page.locator('.wfr-status[data-placement=header]').innerText(), '已取消')
      assert.match(await page.locator('.wfr-orientation').innerText(), /本轮已结束，无需操作/u)
      assert.equal(statuses.filter(label => label === '已停止 · 本轮已结束').length, 1)
      assert.ok(!statuses.some(label => /需处理/u.test(label)))
      assert.equal(await history.count(), 1)
      assert.equal(await page.locator('.wfr-agent-history').count(), 0)
    } else {
      assert.equal(await history.count(), 0)
      if (target.kind === 'unknown') {
        assert.ok(statuses.includes('未确认停止'))
        assert.equal(snapshot.run.outcome, null)
        assert.ok(!statuses.includes('已停止 · 本轮已结束'))
      } else {
        assert.equal(snapshot.run.outcome, 'PASS')
        assert.ok(statuses.every(label => label === '已完成'))
      }
    }
    for (const width of [1440, 540]) {
      if (width === 540) {
        const side = page.getByRole('button', { name: '收起侧边栏', exact: true })
        if (await side.isVisible().catch(() => false)) await side.click()
        const files = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
        if (await files.isVisible().catch(() => false)) await files.click()
      }
      await page.setViewportSize({ width, height: 1050 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const geometry = await view.evaluate(root => ({ overflow: root.scrollWidth > root.clientWidth,
        rowOverflow: [...root.querySelectorAll('.wfr-agent')].some(row => row.scrollWidth > row.clientWidth),
        pluginInputs: root.querySelectorAll('input,textarea,[contenteditable=true]').length,
        nativeInputs: document.querySelectorAll('textarea,[contenteditable=true]').length }))
      assert.equal(geometry.overflow, false); assert.equal(geometry.rowOverflow, false)
      assert.equal(geometry.pluginInputs, 0); assert.equal(geometry.nativeInputs, 1)
      if (target.kind === 'ended') {
        assert.doesNotMatch((await rows.allInnerTexts()).join('\n'), /需处理|需要决定|\/workflow-budget/u)
      }
      await page.evaluate(() => {
        let node = document.querySelector('.wfr-view')
        while (node) { if (node.scrollHeight > node.clientHeight) node.scrollTop = 0; node = node.parentElement }
      })
      await page.screenshot({ path: join(output, `${target.name}-${width}.png`), fullPage: true })
      report.checks.push({ name: target.name, width, revision: snapshot.revision, statuses, ...geometry })
      if (target.kind === 'ended') {
        const button = history.getByRole('button', { name: '历史中断记录', exact: true })
        assert.equal(await button.getAttribute('aria-expanded'), 'false')
        // Verify native disclosure keyboard access, not only a synthetic click.
        await button.focus(); await button.press('Enter')
        assert.equal(await button.getAttribute('aria-expanded'), 'true')
        const detail = page.locator('.wfr-agent-history'), old = snapshot.run.agents.find(agent => agent.runtimeIssue?.status === 'stopped')
        const text = await detail.innerText()
        assert.ok(text.includes(old.runtimeIssue.reason))
        if (old.lastSummary) assert.ok(text.includes(old.lastSummary))
        assert.match(text, /不是当前操作要求/u)
        assert.equal(await detail.evaluate(node => node.scrollWidth > node.clientWidth), false)
        await detail.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(output, `${target.name}-${width}-history.png`), fullPage: true })
        await button.focus(); await button.press(' ')
        assert.equal(await button.getAttribute('aria-expanded'), 'false')
        assert.equal(await page.locator('.wfr-agent-history').count(), 0)
        report.checks.push({ name: `${target.name}-history`, width, exactEvidenceRetained: true, keyboardToggle: true })
      }
    }
    await page.close()
    console.log(`${target.name}: wide/narrow passed`)
  }
  assert.equal(report.errors.length, 0); assert.equal(report.blockedWrites.length, 0); assert.equal(report.failedRequests.length, 0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error).replaceAll(url, 'http://127.0.0.1:3080/[auth-redacted]'); process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  await browser.close()
  console.log(JSON.stringify({ status: report.status, error: report.error, checks: report.checks.length,
    candidateServed: report.candidateServed, blockedWrites: report.blockedWrites, errors: report.errors, output }))
}
