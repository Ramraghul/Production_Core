#!/usr/bin/env node
'use strict';

/**
 * Generate flows/flows.json from flows/plant.spec.js.
 *
 *   npm run build:flows     write the file
 *   npm run verify:flows    fail if the committed file is stale (used in CI)
 *
 * Because ids are derived from logical names, regenerating an unchanged spec
 * produces a byte-identical file. That is what makes the generated artefact
 * safe to commit: a diff on flows.json shows only what actually changed.
 */

const fs = require('fs');
const path = require('path');

const { buildFlows } = require('../flows/plant.spec');

const OUTPUT = path.resolve(__dirname, '..', 'flows', 'flows.json');
const checkOnly = process.argv.includes('--check');

/** Validate structural invariants Node-RED would otherwise fail on at load. */
function validate(flows) {
  const problems = [];
  const ids = new Set();
  const tabIds = new Set(flows.filter((f) => f.type === 'tab').map((f) => f.id));
  const configIds = new Set(
    flows.filter((f) => f.z === undefined && f.type !== 'tab').map((f) => f.id)
  );

  for (const node of flows) {
    if (!node.id) problems.push(`Node of type '${node.type}' has no id`);
    if (ids.has(node.id)) problems.push(`Duplicate node id '${node.id}'`);
    ids.add(node.id);

    if (node.z !== undefined && !tabIds.has(node.z)) {
      problems.push(`Node '${node.id}' (${node.type}) references unknown tab '${node.z}'`);
    }

    for (const outputs of node.wires || []) {
      for (const target of outputs) {
        if (!ids.has(target) && !flows.some((f) => f.id === target)) {
          problems.push(`Node '${node.id}' wires to unknown node '${target}'`);
        }
      }
    }

    // A wired output count that disagrees with the declared one silently drops
    // messages at runtime, which is miserable to debug in the editor.
    if (node.type === 'function' && node.outputs !== undefined) {
      if ((node.wires || []).length > node.outputs) {
        problems.push(
          `Function '${node.name}' declares ${node.outputs} output(s) but has ` +
          `${node.wires.length} wired`
        );
      }
    }
    if (node.type === 'switch' && node.rules && node.outputs !== node.rules.length) {
      problems.push(`Switch '${node.name}' has ${node.rules.length} rules but ${node.outputs} outputs`);
    }

    // Every mqtt node must point at a broker config that exists.
    if ((node.type === 'mqtt in' || node.type === 'mqtt out') && !configIds.has(node.broker)) {
      problems.push(`MQTT node '${node.name}' references unknown broker '${node.broker}'`);
    }
  }

  return problems;
}

function main() {
  const flows = buildFlows();
  const problems = validate(flows);

  if (problems.length) {
    process.stderr.write('Flow validation failed:\n');
    problems.forEach((p) => process.stderr.write(`  - ${p}\n`));
    process.exit(1);
  }

  const serialised = `${JSON.stringify(flows, null, 2)}\n`;

  if (checkOnly) {
    if (!fs.existsSync(OUTPUT)) {
      process.stderr.write(
        `flows/flows.json is missing. Run \`npm run build:flows\`.\n`
      );
      process.exit(1);
    }
    const existing = fs.readFileSync(OUTPUT, 'utf8');
    if (existing !== serialised) {
      process.stderr.write(
        'flows/flows.json is out of date with flows/plant.spec.js.\n' +
        'Run `npm run build:flows` and commit the result.\n'
      );
      process.exit(1);
    }
    process.stdout.write('flows/flows.json is up to date\n');
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, serialised, 'utf8');

  const tabs = flows.filter((f) => f.type === 'tab');
  const byType = flows.reduce((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {});
  const custom = Object.entries(byType)
    .filter(([type]) => type.startsWith('pc-'))
    .map(([type, count]) => `${type} x${count}`)
    .join(', ');

  process.stdout.write(
    `Wrote ${path.relative(process.cwd(), OUTPUT)}\n` +
    `  ${flows.length} nodes across ${tabs.length} tabs, ` +
    `${(serialised.length / 1024).toFixed(1)} KB\n` +
    `  custom nodes: ${custom}\n\n`
  );
  tabs.forEach((tab) => {
    const count = flows.filter((f) => f.z === tab.id).length;
    process.stdout.write(`  ${tab.label.padEnd(26)} ${String(count).padStart(3)} nodes\n`);
  });
}

main();
