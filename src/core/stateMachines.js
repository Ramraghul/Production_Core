'use strict';

/**
 * Every entity lifecycle in the system, as data.
 *
 * Built from the same transition tables the domain modules enforce, so the
 * diagrams in the documentation are generated from the rules rather than
 * drawn next to them - they cannot drift, because there is nothing separate
 * to drift.
 */

const workOrder = require('./workOrder');
const unit = require('./unit');
const subAssembly = require('./subAssembly');
const quality = require('./quality');
const andon = require('./andon');
const stationControl = require('./stationControl');

/** Turn a { STATE: [next, ...] } table into edges. */
function fromTable(table) {
  return Object.entries(table).flatMap(([from, targets]) =>
    targets.map((to) => ({ from, to })));
}

function machine(name, description, initial, transitions, labels = {}) {
  const states = [...new Set(transitions.flatMap((t) => [t.from, t.to]))];
  const outgoing = new Set(transitions.map((t) => t.from));
  return {
    name,
    description,
    initial,
    states: states.map((state) => ({
      id: state,
      terminal: !outgoing.has(state),
      label: labels[state] || null
    })),
    transitions
  };
}

/** @returns {Object<string, object>} every lifecycle, keyed by entity */
function allStateMachines() {
  return {
    workOrder: machine(
      'Work order',
      'The plant\'s commitment to build N units of one model by a date.',
      'DRAFT',
      fromTable(workOrder.TRANSITIONS)
    ),
    unit: machine(
      'Vehicle',
      'One physical vehicle moving through the plant. Routing and quality gates apply while IN_PROCESS.',
      'PLANNED',
      fromTable(unit.TRANSITIONS)
    ),
    subAssembly: machine(
      'Sub-assembly',
      'A serialised feeder-line module. CONSUMED is terminal: a serial is fitted to exactly one vehicle, ever.',
      'BUILDING',
      fromTable(subAssembly.TRANSITIONS)
    ),
    defect: machine(
      'Defect',
      'A quality finding. CLOSED is terminal - a closed defect cannot be reopened.',
      'OPEN',
      fromTable(quality.DEFECT_TRANSITIONS)
    ),
    andon: machine(
      'Andon call',
      'A cord pulled on the floor. Response time stops on ACKNOWLEDGED; an overdue RAISED call is escalated.',
      'RAISED',
      fromTable(andon.TRANSITIONS)
    ),
    stationControl: machine(
      'Station control mode',
      'Who is in charge of a station. Anything but AUTO is a lockout: automated changes are refused.',
      'AUTO',
      stationControl.CONTROL_TRANSITIONS.map((t) => ({ from: t.from, to: t.to, label: t.action }))
    ),
    maintenanceOrder: machine(
      'Maintenance order',
      'A technician\'s work on a station, with a checklist and planned-versus-actual time.',
      'IN_PROGRESS',
      [
        { from: 'IN_PROGRESS', to: 'COMPLETED' },
        { from: 'IN_PROGRESS', to: 'CANCELLED' }
      ]
    )
  };
}

module.exports = { allStateMachines };
