const fs = require('node:fs');
const path = require('node:path');

const readJson = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const manifest = readJson('workforce.json');
const erazer = readJson('erazer_priority.json');
const asBoolean = value => value === undefined || value === null ? null : String(value).trim().toLowerCase() === 'true';

function workforceStatus(env = process.env) {
  return {
    ok: true,
    system: manifest.system,
    executionMode: manifest.executionMode,
    activePillar: manifest.activePillar,
    pillarOrder: manifest.pillarOrder,
    pillars: manifest.pillars,
    agents: manifest.agents.map(agent => ({
      id: agent.id,
      role: agent.role,
      pillar: agent.pillar,
      status: agent.status,
      mission: agent.mission,
      communication: manifest.communication.status,
    })),
    communication: manifest.communication,
    erazerPriority: {
      rank: 1,
      title: erazer.title,
      handle: erazer.handle,
      referencePriceEUR: erazer.referencePriceEUR,
      locked: true,
      existingVideoPolicy: 'Shopify asset only; missing asset blocks the draft',
      runwayForFlagship: 'forbidden',
    },
    safety: {
      dryRun: true,
      newAdWrites: false,
      adSpendEUR: 0,
      paidVideoGenerationByJarvis: false,
      existingCampaigns: 'read_only_untouched',
      externalWhatsAppDelivery: false,
      runtimeSwitches: {
        DRY_RUN: asBoolean(env.DRY_RUN),
        PILOT_AD_DRY_RUN: asBoolean(env.PILOT_AD_DRY_RUN),
        VIDEO_GENERATION_ENABLED: asBoolean(env.VIDEO_GENERATION_ENABLED),
      },
    },
  };
}

function registerJarvisWorkforce(app) {
  app.get('/api/jarvis/v1/workforce', (_req, res) => res.status(200).json(workforceStatus()));
}

module.exports = {registerJarvisWorkforce, workforceStatus};
