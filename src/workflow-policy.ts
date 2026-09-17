export type WorkflowOutcome = 'passed' | 'qualified' | 'failed' | 'cancelled' | 'unknown'

/** Keep a continued child's current assignment compact enough for the Agent list. */
export function summarizeAgentFollowup(message: string, maxLength = 96): string {
  const firstLine = message.split(/\r?\n/gu).map(line => line.trim()).find(Boolean) ?? ''
  if (firstLine.length <= maxLength) return firstLine
  return `${firstLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function hasPositiveLedgerCount(text: string, label: 'FAIL' | 'WAIVED'): boolean {
  const pattern = new RegExp(`\\b${label}\\b\\s*[：:=]\\s*(\\d+)\\s*(?:项)?`, 'giu')
  for (const match of text.matchAll(pattern)) {
    if (Number(match[1]) > 0) return true
  }
  return false
}

/**
 * Classify the Agent's final delivery language conservatively.
 *
 * A user-approved waiver is still a deviation from the confirmed acceptance
 * contract, so it must win over optimistic phrases such as "全链路通过".
 */
export function classifyWorkflowOutcome(text: string): WorkflowOutcome {
  const value = text.replace(/\s+/gu, ' ').trim()
  if (value.length === 0) return 'unknown'

  // Explicit acceptance-ledger counts outrank optimistic prose. Zero counts,
  // however, must not trigger merely because FAIL/WAIVED labels are present.
  if (hasPositiveLedgerCount(value, 'FAIL')) return 'failed'
  if (hasPositiveLedgerCount(value, 'WAIVED')) return 'qualified'

  if (/(?:结论|总体状态)\s*[：:]?\s*(?:已取消|取消|中止)|用户(?:选择|要求).{0,20}(?:取消|停止)|cancelled/iu.test(value)) {
    return 'cancelled'
  }

  if (/(?:结论|总体状态)\s*[：:]?\s*(?:未通过|失败)|(?:硬性|关键)?验收.{0,40}(?:未通过|失败|未满足)|无法完成|没有正常完成|交付失败|执行中断/iu.test(value)) {
    return 'failed'
  }

  if (/(?:结论|总体状态)\s*[：:]?\s*(?:有条件通过|部分通过|带偏差通过)|偏差记录|已(?:获)?批准.{0,30}偏差|验收豁免|(?:结果|状态)\s*[：:]?\s*waived|\|\s*waived\s*\|/iu.test(value)) {
    return 'qualified'
  }

  if (/(?:结论|总体状态)\s*[：:]?\s*(?:通过|成功)|全链路通过|验收.{0,30}(?:全部通过|全绿)|验证.{0,30}(?:全部通过|全绿)/iu.test(value)) {
    return 'passed'
  }

  return 'unknown'
}
