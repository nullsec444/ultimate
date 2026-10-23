import type { ServerEvents } from '../../shared/protocol.ts'
import type { EventSourceLike } from '../../web/src/sdk/store.ts'

export class FakeSource extends EventTarget implements EventSourceLike {
  readyState = 0
  closed = false
  readonly url: string
  constructor(url: string) {
    super()
    this.url = url
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  /** A dropped connection the browser retries (`closed: false`), or one the server refused. */
  drop(closed = false) {
    this.readyState = closed ? 2 : 0
    this.dispatchEvent(new Event('error'))
  }
  send<K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }))
  }
}
