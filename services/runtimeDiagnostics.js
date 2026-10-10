const { monitorEventLoopDelay } = require('node:perf_hooks');
const safeRoute = (req) => `${req.method} ${req.route ? `${req.baseUrl || ''}${req.route.path}` : '/<unmatched>'}`
  .replace(/[a-f\d]{24}/gi, ':id').replace(/\b\d+\b/g, ':n').slice(0, 140);
function createRuntimeDiagnostics({ log = () => {}, redisStatus = () => ({}),
  dbState = () => 0, intervalMs = 60000 } = {}) {
  const routes = new Map(), delay = monitorEventLoopDelay({ resolution: 20 });
  let timer, cpu = process.cpuUsage(), started = Date.now();
  let total = 0, limited = 0, slow = 0;
  function middleware(req, res, next) {
    const at = process.hrtime.bigint();
    res.once('finish', () => {
      const elapsed = Number(process.hrtime.bigint() - at) / 1e6;
      total++;
      if (res.statusCode === 429) limited++;
      if (elapsed >= 300) slow++;
      let key = safeRoute(req);
      if (!routes.has(key) && routes.size >= 64) key = 'OTHER';
      const row = routes.get(key) || { count: 0, samples: [] };
      row.count++;
      if (row.samples.length < 64) row.samples.push(elapsed);
      else row.samples[row.count % 64] = elapsed;
      routes.set(key, row);
    });
    next();
  }
  function snapshot() {
    const memory = process.memoryUsage(), now = Date.now();
    const used = process.cpuUsage(cpu), elapsed = Math.max(1, now - started);
    const endpoints = Array.from(routes, ([route, row]) => {
      const samples = [...row.samples].sort((a, b) => a - b);
      const pct = (p) => Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] || 0);
      return { route, requests: row.count, p50ms: pct(0.5), p95ms: pct(0.95) };
    });
    const result = { event: 'runtime', uptimeSec: Math.round(process.uptime()),
      rssMB: Math.round(memory.rss / 1048576), heapUsedMB: Math.round(memory.heapUsed / 1048576),
      heapTotalMB: Math.round(memory.heapTotal / 1048576), externalMB: Math.round(memory.external / 1048576),
      cpuPercent: Math.round((used.user + used.system) / (elapsed * 10)),
      eventLoopP95ms: Math.round(delay.percentile(95) / 1e6), mongoState: dbState(),
      redis: redisStatus(), windowSec: Math.round(elapsed / 1000), requests: total,
      requestsPerMin: Math.round(total * 60000 / elapsed), rateLimited: limited, slow, endpoints };
    cpu = process.cpuUsage(); started = now; total = limited = slow = 0;
    routes.clear(); delay.reset();
    return result;
  }
  function start() {
    if (timer) return;
    delay.enable();
    timer = setInterval(() => log(JSON.stringify(snapshot())), intervalMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; delay.disable(); routes.clear(); }
  return { middleware, snapshot, start, stop };
}
module.exports = { createRuntimeDiagnostics, safeRoute };
