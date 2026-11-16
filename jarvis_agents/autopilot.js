"use strict";

const fs = require('node:fs');
const path = require('node:path');

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_RUN_HISTORY = 10;

function isAutopilotEnabled(env = process.env) {
  const value = env.JARVIS_AUTOPILOT_ENABLED;
  return value === undefined || value === null || String(value).trim() === ''
    ? true
    : String(value).trim().toLowerCase() === 'true';
}

function createRunHistoryStore(filePath, {fsImpl = fs.promises, limit = MAX_RUN_HISTORY} = {}) {
  let records = [];
  let loaded = false;
  let loadPromise;
  let writeQueue = Promise.resolve();

  async function load() {
    if (loaded) return records.slice();
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const data = await fsImpl.readFile(filePath, 'utf8');
          const parsed = JSON.parse(data);
          records = Array.isArray(parsed) ? parsed.slice(-limit) : [];
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          records = [];
        }
        loaded = true;
        return records.slice();
      })();
    }
    return loadPromise;
  }

  async function append(entry) {
    await load();
    records = [...records, entry].slice(-limit);
    const snapshot = records.slice();
    writeQueue = writeQueue.then(async () => {
      await fsImpl.mkdir(path.dirname(filePath), {recursive: true});
      const tempPath = `${filePath}.tmp`;
      await fsImpl.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
      await fsImpl.rename(tempPath, filePath);
    });
    await writeQueue;
    return snapshot;
  }

  return {load, append, snapshot: () => records.slice()};
}

function createAutopilotScheduler({
  enabled = true,
  onRun = async () => {},
  setTimeoutFn = setTimeout,
  now = () => Date.now(),
  initialDelayMs = INITIAL_DELAY_MS,
  intervalMs = INTERVAL_MS,
  logger = console,
} = {}) {
  let active = false;
  let timer = null;
  let nextRunAt = null;
  let inFlight = false;

  function schedule(delayMs) {
    if (!active) return;
    nextRunAt = new Date(now() + delayMs).toISOString();
    timer = setTimeoutFn(async () => {
      timer = null;
      nextRunAt = null;
      if (!active) return;
      if (!inFlight) {
        inFlight = true;
        try {
          await onRun('AUTO_SCHEDULED');
        } catch (error) {
          logger.error('[jarvis-autopilot] AUTO_RUN_FAILED', error?.message || String(error));
        } finally {
          inFlight = false;
        }
      }
      schedule(intervalMs);
    }, delayMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function start() {
    if (!enabled) return false;
    if (active) return true;
    active = true;
    schedule(initialDelayMs);
    return true;
  }

  function stop() {
    active = false;
    nextRunAt = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start,
    stop,
    status: () => ({autopilot_active: active, next_scheduled_run_at: nextRunAt, in_flight: inFlight}),
  };
}

async function executeAndRecord(triggerType, {runCycle, historyStore, now = () => Date.now()} = {}) {
  if (!['AUTO_SCHEDULED', 'MANUAL'].includes(triggerType)) {
    throw new Error('INVALID_JARVIS_TRIGGER_TYPE');
  }
  const startedAt = now();
  let cycle;
  try {
    cycle = await runCycle();
  } catch (error) {
    const finishedAt = now();
    cycle = {
      status: 'failed',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      dry_run: true,
      budget_eur: 0,
      ad_spend_eur: 0,
      external_writes_performed: false,
      summary_report: {text: `JARVIS cyklus selhal: ${String(error?.message || error).slice(0, 160)}. Režim dry-run, útrata 0 €.`},
    };
  }
  const finishedAt = now();
  const entry = {
    timestamp: new Date(startedAt).toISOString(),
    trigger_type: triggerType,
    duration_ms: Math.max(0, finishedAt - startedAt),
    comms_agent_summary: String(cycle?.summary_report?.text || ''),
    organic_content: Array.isArray(cycle?.organic_content) ? cycle.organic_content : [],
    unified_pipeline: cycle?.unified_pipeline || null,
    organic_publication: cycle?.organic_publication || [],
  };
  await historyStore.append(entry);
  return {cycle, entry};
}

module.exports = {
  INITIAL_DELAY_MS,
  INTERVAL_MS,
  MAX_RUN_HISTORY,
  isAutopilotEnabled,
  createRunHistoryStore,
  createAutopilotScheduler,
  executeAndRecord,
};

