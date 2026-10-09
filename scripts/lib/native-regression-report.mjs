/** Accept exact TAP inventory, never an exit-0 file with no matching subtests. */
import assert from 'node:assert/strict'

export function nativeRegressionReport(report, expectedNames) {
  assert.ok(Array.isArray(expectedNames) && expectedNames.length > 0, 'nonempty-reviewed-inventory-required')
  assert.equal(new Set(expectedNames).size, expectedNames.length, 'duplicate-reviewed-test-name')
  const executedNames = [...report.matchAll(/^# Subtest: (.+)$/gmu)].map(value => value[1].trim())
  const count = key => Number(report.match(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'mu'))?.[1] ?? NaN)
  const tests = count('tests'), pass = count('pass'), fail = count('fail'), skipped = count('skipped'), cancelled = count('cancelled')
  return { executedNames, tests, pass, fail, skipped, cancelled,
    inventoryMatches: JSON.stringify(executedNames) === JSON.stringify(expectedNames),
    completePass: JSON.stringify(executedNames) === JSON.stringify(expectedNames) && tests === expectedNames.length
      && pass === expectedNames.length && fail === 0 && skipped === 0 && cancelled === 0 }
}
