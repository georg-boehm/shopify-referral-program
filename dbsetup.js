#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const env = { ...process.env }

// Sqlite3 database lives on the persistent volume at /data/dev.sqlite
// DATABASE_URL env var points Prisma there directly
const target = '/data/dev.sqlite'
const newDb = !fs.existsSync(target)
// Skip Litestream restore for now — previous backup had a broken DB.
// Re-enable once the DB is stable:
// if (newDb && process.env.BUCKET_NAME) {
//   await exec(`npx litestream restore -config litestream.yml -if-replica-exists ${target}`)
// }

// prepare database
await exec('npx prisma migrate deploy')

// launch application
if (process.env.BUCKET_NAME) {
  await exec(`npx litestream replicate -config litestream.yml -exec ${JSON.stringify(process.argv.slice(2).join(' '))}`)
} else {
  await exec(process.argv.slice(2).join(' '))
}

function exec(command) {
  const child = spawn(command, { shell: true, stdio: 'inherit', env })
  return new Promise((resolve, reject) => {
    child.on('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} failed rc=${code}`))
      }
    })
  })
}
