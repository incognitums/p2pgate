'use strict'

const { EventEmitter } = require('node:events')

const MUX_VERSION = 1
const DEFAULT_MAX_CHANNELS = 128
const MAX_CARRIERS = 64
const MAX_TOTAL_CHANNELS = 512
const MAX_FRAME = 16 * 1024
const HEADER_BYTES = 10
const CHANNEL_WINDOW = 256 * 1024
const MAX_QUEUED = 64 * 1024
const MAX_CHANNEL_QUEUE = 1024 * 1024
const MUX_IDLE_MS = 5 * 60 * 1000
const KEEPALIVE_MS = 30 * 1000

const TYPE = Object.freeze({
  OPEN: 1,
  OPEN_OK: 2,
  OPEN_ERR: 3,
  DATA: 4,
  WINDOW: 5,
  CLOSE: 6,
  RESET: 7,
  PING: 8,
  PONG: 9
})

const FLAG = Object.freeze({
  FIN: 0x01,
  RESET: 0x02
})

function encodeFrame(type, flags, channelId, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)

  if (body.length > MAX_FRAME) {
    const err = new Error(`mux frame exceeds ${MAX_FRAME} bytes`)
    err.code = 'MUX_FRAME_TOO_LARGE'
    throw err
  }

  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt8(Math.trunc(flags) || 0, 1)
  frame.writeUInt32BE(channelId >>> 0, 2)
  frame.writeUInt32BE(body.length, 6)
  body.copy(frame, HEADER_BYTES)
  return frame
}

class FrameParser {
  constructor(onFrame, onError) {
    this._onFrame = onFrame
    this._onError = onError || (() => {})
    this._pending = Buffer.alloc(0)
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return
    this._pending = this._pending.length === 0
      ? chunk
      : Buffer.concat([this._pending, chunk])

    while (this._pending.length >= HEADER_BYTES) {
      const type = this._pending.readUInt8(0)
      const flags = this._pending.readUInt8(1)
      const channelId = this._pending.readUInt32BE(2)
      const length = this._pending.readUInt32BE(6)

      if (length > MAX_FRAME) {
        this._onError(new Error(`invalid mux frame length ${length}`))
        return
      }

      if (this._pending.length < HEADER_BYTES + length) return

      const payload = Buffer.from(
        this._pending.subarray(HEADER_BYTES, HEADER_BYTES + length)
      )
      this._pending = this._pending.subarray(HEADER_BYTES + length)
      this._onFrame({ type, flags, channelId, payload })
    }
  }
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function decodeJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

class MuxChannel extends EventEmitter {
  constructor(carrier, id, meta = {}) {
    super()
    this.carrier = carrier
    this.id = id
    this.meta = meta
    this.creditOut = CHANNEL_WINDOW
    this.creditIn = CHANNEL_WINDOW
    this.queue = []
    this.queuedBytes = 0
    this.closed = false
    this._pendingData = []
    this._needDrain = false
    this._localEnded = false
    this._remoteEnded = false
    this._sentFin = false
    this._abortTimer = null
  }

  on(event, listener) {
    super.on(event, listener)

    if (event === 'data' && this._pendingData.length > 0) {
      const pending = this._pendingData
      this._pendingData = []

      for (const chunk of pending) listener(chunk)
    }

    return this
  }

  write(data, callback) {
    if (this.closed) {
      if (callback) callback(new Error('channel closed'))
      return false
    }

    if (this._localEnded) {
      const err = muxError('channel write side is closed', 'MUX_WRITE_AFTER_END')
      if (callback) callback(err)
      return false
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)

    if (buffer.length === 0) {
      if (callback) callback()
      return true
    }

    if (this.queuedBytes >= MAX_CHANNEL_QUEUE) {
      const err = muxError('channel queue overflow', 'MUX_QUEUE_OVERFLOW')
      if (callback) callback(err)
      this.destroy()
      return false
    }

    this.queue.push({ buffer, callback })
    this.queuedBytes += buffer.length
    this._flush()

    if (this.queuedBytes === 0) return true

    this._needDrain = true
    return false
  }

  end() {
    if (this.closed || this._localEnded) return

    this._localEnded = true
    this._flush()
  }

  destroy() {
    if (this.closed) return
    this.carrier._send(TYPE.RESET, FLAG.RESET, this.id)
    this._finish()
  }

  _flush() {
    while (!this.closed && this.creditOut > 0 && this.queue.length > 0) {
      const item = this.queue[0]
      const size = Math.min(this.creditOut, item.buffer.length, MAX_FRAME)
      const slice = item.buffer.subarray(0, size)

      this.creditOut -= size
      this.queuedBytes -= size
      item.buffer = item.buffer.subarray(size)

      this.carrier._send(TYPE.DATA, 0, this.id, slice)

      if (item.buffer.length === 0) {
        this.queue.shift()
        if (item.callback) item.callback()
      }
    }

    if (this.queuedBytes === 0 && this._needDrain) {
      this._needDrain = false
      process.nextTick(() => {
        if (!this.closed) this.emit('drain')
      })
    }

    this._maybeClose()
  }

  _maybeClose() {
    if (this.closed || !this._localEnded || this._sentFin) return
    if (this.queue.length > 0) return

    this._sentFin = true
    this.carrier._send(TYPE.CLOSE, 0, this.id)

    if (this._remoteEnded) this._finish()
  }

  // Peer sent CLOSE (FIN): it will not write more, but we may still send.
  _onRemoteEnd() {
    if (this.closed || this._remoteEnded) return

    this._remoteEnded = true
    this.emit('end')

    if (this._sentFin) {
      this._finish()
      return
    }

    // Guard against a peer that closes its side and never reads ours.
    this._abortTimer = setTimeout(() => {
      this._abortTimer = null
      if (!this.closed) this._finish()
    }, 60_000)
    if (typeof this._abortTimer.unref === 'function') this._abortTimer.unref()
  }

  _onData(payload) {
    if (this.closed) return

    this.carrier._send(TYPE.WINDOW, 0, this.id, encodeUInt32(payload.length))

    if (this.listenerCount('data') === 0) {
      this._pendingData.push(payload)
      return
    }

    this.emit('data', payload)
  }

  _onWindow(increment) {
    this.creditOut = Math.min(this.creditOut + increment, CHANNEL_WINDOW)
    this._flush()
  }

  _finish() {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.queuedBytes = 0
    this._needDrain = false

    if (this._abortTimer) {
      clearTimeout(this._abortTimer)
      this._abortTimer = null
    }

    this.carrier._forget(this.id)
    this.emit('close')
  }
}

function encodeUInt32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

function decodeUInt32(buffer) {
  if (buffer.length < 4) return 0
  return buffer.readUInt32BE(0)
}

/**
 * Carrier over an authenticated stream. One carrier carries many channels.
 */
class MuxCarrier extends EventEmitter {
  constructor(stream, options = {}) {
    super()

    this.stream = stream
    this.maxChannels = Number.isInteger(options.maxChannels)
      ? options.maxChannels
      : DEFAULT_MAX_CHANNELS
    this.channels = new Map()
    this.nextId = 1
    this.closed = false
    this.idleMs = Number.isInteger(options.idleMs) ? options.idleMs : MUX_IDLE_MS
    this._idleTimer = null
    this._keepalive = null
    this._pendingOpen = new Map()

    this._parser = new FrameParser(
      (frame) => this._onFrame(frame),
      (err) => this._fail(err)
    )

    if (Buffer.isBuffer(options.leftover) && options.leftover.length > 0) {
      this._parser.push(options.leftover)
    }

    stream.on('data', (chunk) => this._parser.push(chunk))
    stream.on('error', (err) => this._fail(err))
    stream.on('close', () => this._fail(new Error('carrier closed')))

    this._touchIdle()
  }

  openChannel(request, timeoutMs = 10_000) {
    if (this.closed) {
      return Promise.reject(muxError('carrier is closed', 'MUX_CARRIER_CLOSED'))
    }

    if (this.channels.size >= this.maxChannels) {
      return Promise.reject(muxError('too many channels', 'MUX_BUSY'))
    }

    const id = this.nextId++
    this._touchIdle()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingOpen.delete(id)
        reject(muxError('channel open timed out', 'MUX_OPEN_TIMEOUT'))
      }, timeoutMs)

      this._pendingOpen.set(id, { resolve, reject, timer })
      this._send(TYPE.OPEN, 0, id, encodeJson(request))
    })
  }

  stats() {
    return {
      closed: this.closed,
      channels: this.channels.size,
      maxChannels: this.maxChannels
    }
  }

  close() {
    if (this.closed) return
    this._fail(new Error('carrier closed by client'))
  }

  _send(type, flags, channelId, payload = Buffer.alloc(0)) {
    if (this.closed) return

    try {
      this.stream.write(encodeFrame(type, flags, channelId, payload))
    } catch (err) {
      this._fail(err)
    }
  }

  _onFrame(frame) {
    this._touchIdle()

    switch (frame.type) {
      case TYPE.OPEN_OK: {
        const pending = this._pendingOpen.get(frame.channelId)
        if (!pending) break
        clearTimeout(pending.timer)
        this._pendingOpen.delete(frame.channelId)

        const meta = decodeJson(frame.payload) || {}
        const channel = new MuxChannel(this, frame.channelId, meta)
        this.channels.set(frame.channelId, channel)
        pending.resolve(channel)
        break
      }

      case TYPE.OPEN_ERR: {
        const pending = this._pendingOpen.get(frame.channelId)
        if (!pending) break
        clearTimeout(pending.timer)
        this._pendingOpen.delete(frame.channelId)

        const meta = decodeJson(frame.payload) || {}
        pending.reject(muxError(
          meta.message || 'channel rejected',
          meta.error || 'MUX_OPEN_FAILED'
        ))
        break
      }

      case TYPE.DATA: {
        const channel = this.channels.get(frame.channelId)
        if (channel) channel._onData(frame.payload)
        break
      }

      case TYPE.WINDOW: {
        const channel = this.channels.get(frame.channelId)
        if (channel) channel._onWindow(decodeUInt32(frame.payload))
        break
      }

      case TYPE.CLOSE: {
        const channel = this.channels.get(frame.channelId)
        if (channel) channel._onRemoteEnd()
        break
      }

      case TYPE.RESET: {
        const channel = this.channels.get(frame.channelId)
        if (channel) channel._finish()
        break
      }

      case TYPE.PING:
        this._send(TYPE.PONG, 0, 0, frame.payload)
        break

      default:
        break
    }
  }

  _forget(id) {
    this.channels.delete(id)
    this._touchIdle()
  }

  _touchIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer)

    const arm = () => {
      this._idleTimer = setTimeout(() => {
        if (this.channels.size === 0) {
          this._fail(new Error('carrier idle timeout'))
        } else {
          arm()
        }
      }, this.idleMs)
      this._idleTimer.unref()
    }

    arm()

    if (!this._keepalive) {
      this._keepalive = setInterval(() => {
        if (this.closed) return
        this._send(TYPE.PING, 0, 0, Buffer.alloc(0))
      }, KEEPALIVE_MS)
      this._keepalive.unref()
    }
  }

  _fail(err) {
    if (this.closed) return
    this.closed = true

    if (this._idleTimer) clearTimeout(this._idleTimer)
    if (this._keepalive) clearInterval(this._keepalive)

    for (const pending of this._pendingOpen.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this._pendingOpen.clear()

    for (const channel of [...this.channels.values()]) {
      channel.closed = true
      channel.emit('error', err)
      channel.emit('close')
    }
    this.channels.clear()

    try {
      if (!this.stream.destroyed) this.stream.destroy()
    } catch {
      // Ignore.
    }

    this.emit('close', err)
  }
}

function muxError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

module.exports = {
  MUX_VERSION,
  DEFAULT_MAX_CHANNELS,
  MAX_CARRIERS,
  MAX_TOTAL_CHANNELS,
  MAX_FRAME,
  HEADER_BYTES,
  CHANNEL_WINDOW,
  MAX_QUEUED,
  MAX_CHANNEL_QUEUE,
  MUX_IDLE_MS,
  TYPE,
  FLAG,
  encodeFrame,
  FrameParser,
  encodeJson,
  decodeJson,
  encodeUInt32,
  decodeUInt32,
  MuxCarrier,
  MuxChannel,
  muxError
}
