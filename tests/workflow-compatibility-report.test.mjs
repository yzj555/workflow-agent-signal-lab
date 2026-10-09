import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeRegressionReport } from '../scripts/lib/native-regression-report.mjs'

const expected = ['coordinator isolation', 'native command admission']
const tap = (names, footer = '# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0') =>
  'TAP version 13\n' + names.map((name, index) => '# Subtest: ' + name + '\nok ' + (index + 1) + ' - ' + name + '\n').join('') + footer + '\n'

test('compatibility report accepts only the full named inventory and complete counters', () => {
  const report = nativeRegressionReport(tap(expected), expected)
  assert.equal(report.completePass, true)
  assert.deepEqual(report.executedNames, expected)
  assert.equal(nativeRegressionReport(tap(expected).replaceAll('\n', '\r\n'), expected).completePass, true)
})

test('compatibility report rejects a file-level success when a wrong pattern matched no subtest', () => {
  assert.equal(nativeRegressionReport(tap(['tests/workflow-native.test.mjs'], '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0'), expected).completePass, false)
  assert.equal(nativeRegressionReport('# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n', expected).completePass, false)
})

test('compatibility report rejects filtered, duplicated, skipped, cancelled, failed and truncated runs', () => {
  for (const names of [[expected[0]], [expected[0], expected[0]], [...expected].reverse()]) {
    assert.equal(nativeRegressionReport(tap(names), expected).completePass, false)
  }
  for (const footer of ['# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# cancelled 0',
    '# tests 2\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 1',
    '# tests 2\n# pass 1\n# fail 1\n# skipped 0\n# cancelled 0', '# tests 2\n# pass 2\n# fail 0']) {
    assert.equal(nativeRegressionReport(tap(expected, footer), expected).completePass, false)
  }
})

test('compatibility report requires an explicit nonempty unique inventory', () => {
  for (const names of [undefined, [], ['same', 'same']]) assert.throws(() => nativeRegressionReport('', names))
})
