/**
 * privacy-status.mjs — diagnostic for the outbound LLM privacy guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * A guard that is silently misconfigured is worse than no guard, because it
 * looks like protection. This command answers, without sending anything:
 *
 *   - is the guard running, and which config file did it read?
 *   - how many configured values are actually being guarded, and how many were
 *     dropped for being too short to guard safely?
 *   - which pattern detectors are active?
 *   - is the process-level bypass in effect?
 *
 * It never prints a configured value. It reports counts and categories only, in
 * the same discipline the guard's error messages follow — because a diagnostic
 * that echoes the secret into a terminal, a screenshot or a chat log defeats the
 * thing it is diagnosing.
 *
 * USAGE
 *   node privacy-status.mjs
 *   node privacy-status.mjs --json     # machine-readable, for scripts and CI
 *
 * EXIT CODES
 *   0  guard active and usable (including the documented "no config" state)
 *   1  the guard could not be loaded (config present but unreadable/malformed)
 *   2  the guard is explicitly bypassed for this process
 */

import { existsSync } from 'node:fs';
import {
  AUTO_DETECT_DEFAULTS,
  PrivacyConfigError,
  getPrivacyConfigPath,
  getPrivacyExamplePath,
  loadPrivacyGuard,
  readPrivacyConfig,
} from './lib/privacy-guard.mjs';
import { LLM_HOSTS } from './lib/llm-outbound.mjs';

const asJson = process.argv.includes('--json');

/**
 * @typedef {object} StatusReport
 * @property {'active'|'bypassed'|'config-error'} state
 * @property {string} configPath
 * @property {boolean} configPresent
 * @property {string} configSource
 * @property {number} configuredCount
 * @property {Record<string, boolean>} autoDetect
 * @property {number} llmHostCount
 * @property {string} [error]
 */

/** @returns {StatusReport} */
function collect() {
  const configPath = getPrivacyConfigPath();
  const report = {
    state: 'active',
    configPath,
    configPresent: existsSync(configPath),
    configSource: 'unknown',
    configuredCount: 0,
    autoDetect: { ...AUTO_DETECT_DEFAULTS },
    llmHostCount: LLM_HOSTS.length,
  };

  try {
    const config = readPrivacyConfig();
    report.configSource = config.source;
    report.autoDetect = { ...AUTO_DETECT_DEFAULTS, ...config.autoDetect };

    const guard = loadPrivacyGuard({ config });
    if (!guard.enabled) {
      report.state = 'bypassed';
      return report;
    }
    report.configuredCount = guard.configuredCount;
    return report;
  } catch (err) {
    if (err instanceof PrivacyConfigError) {
      report.state = 'config-error';
      report.error = err.message;
      return report;
    }
    throw err;
  }
}

function render(report) {
  const lines = [];
  lines.push('career-ops privacy guard — status');
  lines.push('');
  lines.push(`  state            ${report.state}`);
  lines.push(`  config file      ${report.configPath}`);
  lines.push(`  config present   ${report.configPresent ? 'yes' : 'no'}`);
  lines.push(`  config source    ${report.configSource}`);
  lines.push(`  guarded values   ${report.configuredCount}`);

  const active = Object.entries(report.autoDetect)
    .filter(([, on]) => on)
    .map(([k]) => k);
  const off = Object.entries(report.autoDetect)
    .filter(([, on]) => !on)
    .map(([k]) => k);
  lines.push(`  auto-detect on   ${active.length ? active.join(', ') : '(none)'}`);
  lines.push(`  auto-detect off  ${off.length ? off.join(', ') : '(none)'}`);
  lines.push(`  LLM hosts known  ${report.llmHostCount}`);
  lines.push('');

  if (report.state === 'config-error') {
    lines.push('  ⚠️  The guard could NOT be loaded:');
    lines.push(`      ${report.error}`);
    lines.push('      The guard refuses to run on a config it cannot read. Fix the file,');
    lines.push('      or remove it to run with pattern detection only.');
    return lines.join('\n');
  }

  if (report.state === 'bypassed') {
    lines.push('  ⚠️  The guard is BYPASSED for this process');
    lines.push('      (PRIVACY_GUARD=off with PRIVACY_BYPASS_TOKEN set).');
    lines.push('      Nothing is being inspected. Unset both to re-enable.');
    return lines.join('\n');
  }

  if (report.configSource === 'absent') {
    lines.push('  ℹ️  No config/privacy.yml — running with pattern detection only.');
    lines.push('      To guard your own values too:');
    lines.push(`        copy ${getPrivacyExamplePath()}`);
    lines.push(`          →  ${report.configPath}`);
    lines.push('      and replace the fictional placeholders with your own.');
  } else if (report.configSource === 'empty') {
    lines.push('  ℹ️  config/privacy.yml exists but configures no values —');
    lines.push('      running with pattern detection only.');
  } else if (report.configuredCount === 0) {
    lines.push('  ℹ️  config/privacy.yml loaded, but every value was too short to guard');
    lines.push('      safely (5+ characters, 5+ digits). Nothing configured is protected.');
  } else {
    lines.push(`  ✅ Guard active: ${report.configuredCount} configured value(s) and`);
    lines.push('     the enabled patterns above are blocked on outbound LLM requests.');
  }
  return lines.join('\n');
}

const report = collect();
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(render(report));
}

if (report.state === 'config-error') process.exit(1);
if (report.state === 'bypassed') process.exit(2);
process.exit(0);
