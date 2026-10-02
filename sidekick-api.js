'use strict';

function registerSidekickApi(app, dependencies) {
  const { sidekick, apiKey, catalogState, catalogInterval, catalogRun, validateProduct } = dependencies;
  const tasks = [];
  const results = new Map();

  app.post('/api/sidekick/tasks', apiKey, (req, res) => {
    const task = { id: 'ht-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), createdAt: new Date().toISOString(), status: 'queued', ...(req.body || {}) };
    tasks.push(task);
    res.status(201).json({ ok: true, task });
  });
  app.get('/api/sidekick/tasks/next', sidekick, (_req, res) => {
    const task = tasks.find(item => item.status === 'queued');
    if (!task) return res.json({ ok: true, task: null });
    task.status = 'leased';
    task.leasedAt = new Date().toISOString();
    res.json({ ok: true, task });
  });
  app.post('/api/sidekick/tasks/:id/result', sidekick, (req, res) => {
    const task = tasks.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.result = req.body || {};
    results.set(task.id, task.result);
    res.json({ ok: true, task });
  });
  app.get('/api/sidekick/tasks/status', sidekick, (_req, res) => res.json({
    ok: true,
    queued: tasks.filter(item => item.status === 'queued').length,
    leased: tasks.filter(item => item.status === 'leased').length,
    completed: tasks.filter(item => item.status === 'completed').length
  }));
  app.post('/api/sidekick/automation/run', sidekick, (_req, res) => {
    if (catalogState.running) return res.json({ ok: true, skipped: true });
    void catalogRun();
    res.json({ ok: true, started: true });
  });
  app.get('/api/sidekick/automation/status', sidekick, (_req, res) => res.json({
    ok: true,
    source: 'railway',
    enabled: process.env.HOMESTRO_CATALOG_ENABLED !== 'false',
    intervalMs: catalogInterval(),
    running: catalogState.running,
    lastRun: catalogState.lastRun,
    lastError: catalogState.lastError,
    totals: { created: catalogState.created, rejected: catalogState.rejected, failed: catalogState.failed }
  }));
  app.post('/api/sidekick/products/validate', sidekick, (req, res) => res.json({ ok: true, ...validateProduct(req.body || {}) }));

  return { tasks, results };
}

module.exports = { registerSidekickApi };
