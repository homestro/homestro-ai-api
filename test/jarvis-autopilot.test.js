"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  INITIAL_DELAY_MS,
  INTERVAL_MS,
  isAutopilotEnabled,
  createAutopilotScheduler,
  createRunHistoryStore,
  executeAndRecord,
} = require('../jarvis_agents/autopilot');

test('autopilot defaults on and can be safely disabled', () => {
  assert.equal(isAutopilotEnabled({}), true);
  assert.equal(isAutopilotEnabled({JARVIS_AUTOPILOT_ENABLED: 'true'}), true);
  assert.equal(isAutopilotEnabled({JARVIS_AUTOPILOT_ENABLED: 'false'}), false);
});

test('scheduler registers startup run after 60 seconds then every six hours', async () => {
  let current = Date.parse('2026-11-14T12:00:00.000Z');
  const timers = [];
  const runs = [];
  const scheduler = createAutopilotScheduler({
    enabled: true,
    now: () => current,
    setTimeoutFn: (callback, delay) => {
      const timer = {callback, delay, unref() {}};
      timers.push(timer);
      return timer;
    },
    onRun: async trigger => { runs.push(trigger); },
  });

  assert.equal(scheduler.start(), true);
  assert.equal(timers[0].delay, INITIAL_DELAY_MS);
  assert.equal(scheduler.status().autopilot_active, true);
  assert.equal(scheduler.status().next_scheduled_run_at, '2026-11-14T12:01:00.000Z');

  current += INITIAL_DELAY_MS;
  await timers[0].callback();
  assert.deepEqual(runs, ['AUTO_SCHEDULED']);
  assert.equal(timers[1].delay, INTERVAL_MS);
  assert.equal(scheduler.status().next_scheduled_run_at, '2026-11-14T18:01:00.000Z');
  scheduler.stop();
});

test('run history persists only the latest ten runs and records the Czech comms summary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-history-'));
  const filePath = path.join(dir, 'jarvis-run-history.json');
  const store = createRunHistoryStore(filePath);
  const summary = 'JARVIS cyklus completed: 4/4 pilíře, dry-run, útrata 0 €.';

  for (let index = 0; index < 11; index += 1) {
    await store.append({
      timestamp: new Date(Date.UTC(2026, 10, 14, 0, index)).toISOString(),
      trigger_type: index === 10 ? 'MANUAL' : 'AUTO_SCHEDULED',
      duration_ms: index,
      comms_agent_summary: summary,
    });
  }

  const restored = createRunHistoryStore(filePath);
  const history = await restored.load();
  assert.equal(history.length, 10);
  assert.equal(history[0].duration_ms, 1);
  assert.equal(history.at(-1).trigger_type, 'MANUAL');
  assert.equal(history.at(-1).comms_agent_summary, summary);
});

test('executeAndRecord logs trigger, duration, and comms summary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-run-'));
  const store = createRunHistoryStore(path.join(dir, 'history.json'));
  let time = 1000;
  const {cycle, entry} = await executeAndRecord('AUTO_SCHEDULED', {
    historyStore: store,
    now: () => time++,
    runCycle: async () => ({status: 'completed', summary_report: {text: 'Hotovo: 4/4 pilíře.'}}),
  });

  assert.equal(cycle.status, 'completed');
  assert.equal(entry.trigger_type, 'AUTO_SCHEDULED');
  assert.equal(entry.duration_ms, 1);
  assert.equal(entry.comms_agent_summary, 'Hotovo: 4/4 pilíře.');
  assert.equal((await store.load()).length, 1);
});

