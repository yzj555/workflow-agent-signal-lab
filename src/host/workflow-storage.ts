import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Sqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { join } from 'node:path'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../workflow-journal.ts'
import { acquireWorkflowOwner } from './workflow-owner.ts'

export const WORKFLOW_DOMAIN_NAME = 'workflow_runtime'
export const workflowDomainSpec = Domains.defineDomain({
  name: WORKFLOW_DOMAIN_NAME,
  version: 1,
  tables: {
    sessions: Domains.domainTable(z.unknown().transform((candidate, context) => {
      try { return parseWorkflowJournalRecord(candidate) }
      catch (error) {
        context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid workflow journal' })
        return z.NEVER
      }
    })),
  },
})

export interface WorkflowStorageRuntime {
  readonly journal: WorkflowJournal
  readonly directory: string
  close(): Promise<void>
}

/** Private official storage composition; never changes the Host's global storage routing. */
export async function openWorkflowStorage(dataDirectory: string, reportError: (error: unknown) => void = () => {}): Promise<WorkflowStorageRuntime> {
  const owner = await acquireWorkflowOwner(dataDirectory)
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(Sqlite, { path: join(owner.directory, 'journal.sqlite'), journalMode: 'wal' })
    await ctx.plugin(Domains, { backend: 'sqlite' })
    const domain = await ctx.storageDomain.open(workflowDomainSpec)
    const journal = new WorkflowJournal(domain.table('sessions'), Date.now, reportError)
    let disposal: Promise<void> | undefined
    return {
      journal,
      directory: owner.directory,
      close() {
        disposal ??= (async () => {
          await journal.close()
          await domain.close()
          await ctx.fiber.dispose()
          // Only release after all writes drain and the official DB has closed.
          await owner.release()
        })()
        return disposal
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await owner.release()
    throw error
  }
}
