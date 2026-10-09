/* global MegaErrors */
;(root => {
  const request = value =>
    new Promise((resolve, reject) => {
      value.onsuccess = () => resolve(value.result)
      value.onerror = () => reject(value.error)
    })
  const size = text => new TextEncoder().encode(text).length
  const defaults = () => ({ bytes: 0, limit: 3 * 1024 * 1024, revision: 0 })

  function entry(event, details = {}) {
    const fields = {}
    if (/^[a-z_]{1,48}$/.test(event)) {
      fields.event = event
    } else {
      fields.event = 'unknown_event'
    }
    if (['proxy', 'direct', 'system'].includes(details.mode)) {
      fields.mode = details.mode
    }
    if (Number.isInteger(details.profile) && details.profile >= 0) {
      fields.profile = details.profile
    }
    if (['main_frame', 'xmlhttprequest'].includes(details.type)) {
      fields.type = details.type
    }
    if (details.code) {
      fields.code =
        /^(?:(?:NS_ERROR_|SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_ERROR_)[A-Z0-9_]+|(?:net::)?ERR_[A-Z0-9_]+|error[A-Z][A-Za-z]+)$/.test(
          details.code
        )
          ? details.code.slice(0, 96)
          : 'unexpected_error'
    }
    if (details.operation || details.reason || details.status || details.resource) {
      const safe = MegaErrors.details(details)
      fields.operation = safe.operation
      if (safe.reason) {
        fields.reason = safe.reason
      }
      if (safe.resource) {
        fields.resource = safe.resource
      }
      if (safe.status) {
        fields.status = safe.status
      }
      if (safe.responseBody) {
        fields.responseBody = safe.responseBody
      }
    }
    return fields
  }

  class DiagnosticLog {
    constructor() {
      this.buffer = []
      this.timer = null
      this.queue = Promise.resolve()
    }

    async database() {
      if (!this.db) {
        this.db = new Promise((resolve, reject) => {
          const opening = indexedDB.open('megaproxy-diagnostics', 1)
          opening.onupgradeneeded = () => {
            opening.result.createObjectStore('chunks', { autoIncrement: true })
            opening.result.createObjectStore('meta')
          }
          opening.onsuccess = () => resolve(opening.result)
          opening.onerror = () => reject(opening.error)
        }).catch(error => {
          this.db = null
          throw error
        })
      }
      return this.db
    }

    async transaction(mode, work) {
      const db = await this.database()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['chunks', 'meta'], mode)
        let result
        let failure
        tx.oncomplete = () => resolve(result)
        tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('errorLogStorage'))
        Promise.resolve(work(tx.objectStore('chunks'), tx.objectStore('meta')))
          .then(value => {
            result = value
          })
          .catch(error => {
            failure = error
            tx.abort()
          })
      })
    }

    write(event, details) {
      const fields = entry(event, details)
      const key = JSON.stringify(fields)
      const last = this.buffer.at(-1)
      if (last?.key === key) {
        last.count++
      } else {
        // ponytail: bounded pending diagnostics; oldest entries are expendable during an error storm.
        if (this.buffer.length === 256) {
          this.buffer.shift()
        }
        this.buffer.push({ time: new Date().toISOString(), key, fields, count: 1 })
      }
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.flush().catch(() => {})
        }, 500)
      }
    }

    async trim(chunks, meta) {
      if (meta.bytes <= meta.limit) {
        return
      }
      await new Promise((resolve, reject) => {
        const cursor = chunks.openCursor()
        cursor.onerror = () => reject(cursor.error)
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row || meta.bytes <= meta.limit) {
            resolve()
            return
          }
          meta.bytes -= row.value.bytes
          row.delete()
          row.continue()
        }
      })
    }

    flush() {
      clearTimeout(this.timer)
      this.timer = null
      const entries = this.buffer.splice(0)
      if (!entries.length) {
        return this.queue
      }
      const text = entries
        .map(
          row =>
            `${row.time} ${JSON.stringify(row.fields)}${row.count > 1 ? ` ×${row.count}` : ''}\n`
        )
        .join('')
      this.queue = this.queue
        .catch(() => {})
        .then(() =>
          this.transaction('readwrite', async (chunks, store) => {
            const meta = (await request(store.get('state'))) || defaults()
            const bytes = size(text)
            await request(chunks.add({ text, bytes }))
            meta.bytes += bytes
            meta.revision++
            await this.trim(chunks, meta)
            store.put(meta, 'state')
          })
        )
      return this.queue
    }

    async read(revision = -1, maxBytes = 128 * 1024) {
      await this.flush()
      return this.transaction('readonly', async (chunks, store) => {
        const meta = (await request(store.get('state'))) || defaults()
        if (meta.revision === revision) {
          return { meta }
        }
        const rows = []
        let bytes = 0
        await new Promise((resolve, reject) => {
          const cursor = chunks.openCursor(null, 'prev')
          cursor.onerror = () => reject(cursor.error)
          cursor.onsuccess = () => {
            const row = cursor.result
            if (!row || bytes >= maxBytes) {
              resolve()
              return
            }
            rows.push({ id: row.key, text: row.value.text })
            bytes += row.value.bytes
            row.continue()
          }
        })
        return { meta, rows: rows.reverse() }
      })
    }

    async configure(limitMB, clear = false) {
      if (!Number.isInteger(limitMB) || limitMB < 1 || limitMB > 10) {
        throw new Error('errorLogLimit')
      }
      await this.flush()
      await this.transaction('readwrite', async (chunks, store) => {
        const meta = (await request(store.get('state'))) || defaults()
        meta.limit = limitMB * 1024 * 1024
        if (clear) {
          chunks.clear()
          meta.bytes = 0
        } else {
          await this.trim(chunks, meta)
        }
        meta.revision++
        store.put(meta, 'state')
      })
    }
  }
  root.MegaDiagnosticLog = DiagnosticLog
})(globalThis)
