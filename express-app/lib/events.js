require('dotenv').config();

// One emit() for every process. server.js calls setIo() with the live
// Socket.IO instance; the slot-dispatcher worker never does, so emit() falls
// back to @socket.io/redis-emitter — the message goes through the same Redis
// adapter channel and reaches clients on every PM2 core (v3.0 §2/§4).
// Fails open: a Redis hiccup drops an event, never a request; the dashboards'
// 30s reconcile poll (v3.0 §8) corrects the drift.
let io = null;
let emitter = null;

function setIo(instance) {
  io = instance;
}

function emit(event, payload) {
  try {
    if (io) return void io.emit(event, payload);
    if (!emitter) {
      const { Emitter } = require('@socket.io/redis-emitter');
      const IORedis = require('ioredis');
      const client = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: 1,
      });
      client.on('error', (err) => console.error('[events] Redis error:', err.message));
      emitter = new Emitter(client);
    }
    emitter.emit(event, payload);
  } catch (err) {
    console.warn(`[events] emit ${event} failed:`, err.message);
  }
}

module.exports = { setIo, emit };
