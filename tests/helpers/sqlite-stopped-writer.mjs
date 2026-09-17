/** Isolated test process only. Bounded lifetime even if the parent fails. */
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2])
db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE u_workflow_runtime_sessions (key TEXT PRIMARY KEY,value TEXT NOT NULL);')
db.prepare('INSERT INTO u_workflow_runtime_sessions VALUES (?,?)').run('base', 'original')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.prepare('INSERT INTO u_workflow_runtime_sessions VALUES (?,?)').run('wal-only', 'committed but not checkpointed')
process.send?.({ ready: true, pid: process.pid })
setTimeout(() => { db.close(); process.exit(0) }, 15000)
