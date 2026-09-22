'use strict';

/**
 * Equipment failure and sensor behaviour.
 *
 * Failures are drawn from each station's MTBF as an exponential process, which
 * is the standard reliability model: the probability of failing in the next
 * `dt` seconds is `1 - exp(-dt / MTBF)`, independent of how long the station
 * has already been running. Repairs use the same shape against MTTR.
 *
 * Telemetry is shaped per capability - a weld station reports current and
 * electrode force, a paint booth reports flow and humidity - so the MQTT feed
 * looks like a plant floor rather than a random number generator.
 */

const { CAPABILITIES } = require('../core/plantModel');

/** Realistic operator descriptions, indexed by andon call type. */
const SYMPTOMS = Object.freeze({
  MAINTENANCE: [
    'Station will not cycle, fault lamp lit',
    'Robot in E-stop, no reset available',
    'Tool changer will not release',
    'Drive fault on the transfer conveyor'
  ],
  QUALITY: [
    'Visible defect on the last three units',
    'Torque reading outside control limits',
    'Part will not seat correctly',
    'Gap measurement drifting'
  ],
  MATERIAL: [
    'Line-side rack empty',
    'Wrong part number delivered to the station',
    'Kit missing from the sequence',
    'Fastener bin down to the last handful'
  ],
  TOOLING: [
    'Weld tips need dressing',
    'Nutrunner socket worn',
    'Locating pin damaged',
    'Fixture clamp slipping'
  ],
  PROCESS: [
    'Cycle running long, cannot hold takt',
    'Work instruction does not match the build',
    'Sequence broadcast out of order'
  ],
  SAFETY: [
    'Light curtain tripped repeatedly',
    'Spill at the station',
    'Guard interlock intermittent'
  ]
});

const CORRECTIVE_ACTIONS = Object.freeze({
  MAINTENANCE: ['Reset drive and re-homed the axis', 'Replaced servo amplifier', 'Cleared the fault and cycled the station'],
  QUALITY: ['Re-verified tool calibration', 'Quarantined the suspect lot', 'Adjusted the fixture and re-ran the check'],
  MATERIAL: ['Expedited replenishment from stores', 'Re-routed the correct kit', 'Corrected the sequence broadcast'],
  TOOLING: ['Dressed and replaced weld tips', 'Fitted a new socket', 'Replaced the locating pin'],
  PROCESS: ['Re-balanced the station', 'Reissued the work instruction', 'Resequenced the broadcast'],
  SAFETY: ['Area made safe and cleared', 'Replaced the interlock switch', 'Cleaned the spill and reset']
});

class FaultModel {
  /**
   * @param {object} random deterministic PRNG from core/ids.createRandom
   * @param {object} [options] {enabled}
   */
  constructor(random, options = {}) {
    this.random = random;
    this.enabled = options.enabled !== false;
    /** Explicit repair deadlines set by injectFault, keyed by station id. */
    this.scheduledRepairs = new Map();
  }

  /**
   * Should this station break during the next `elapsedSeconds`?
   * Exponential hazard against the station's MTBF.
   */
  shouldFail(station, elapsedSeconds) {
    if (!this.enabled) return false;
    const mtbfSeconds = (station.mtbfMinutes || 600) * 60;
    const probability = 1 - Math.exp(-elapsedSeconds / mtbfSeconds);
    return this.random.chance(probability);
  }

  /**
   * Should a down station come back up?
   * Honours an explicit deadline from injectFault, otherwise uses MTTR.
   */
  shouldRepair(station, elapsedSeconds) {
    const deadline = this.scheduledRepairs.get(station.id);
    if (deadline !== undefined) {
      const remaining = deadline - elapsedSeconds;
      if (remaining <= 0) {
        this.scheduledRepairs.delete(station.id);
        return true;
      }
      this.scheduledRepairs.set(station.id, remaining);
      return false;
    }

    const mttrSeconds = (station.mttrMinutes || 10) * 60;
    const probability = 1 - Math.exp(-elapsedSeconds / mttrSeconds);
    return this.random.chance(probability);
  }

  /** Hold a station down for a fixed number of simulated seconds. */
  scheduleRepair(stationId, durationSeconds) {
    this.scheduledRepairs.set(stationId, durationSeconds);
  }

  /**
   * Which andon call a failure at this station would produce.
   * A robot cell fails differently from a manual trim station.
   */
  callTypeFor(station) {
    if (station.robots) {
      return this.random.weighted([['MAINTENANCE', 7], ['TOOLING', 2], ['PROCESS', 1]]);
    }
    if (station.capability === CAPABILITIES.TEST || station.capability === CAPABILITIES.INSPECT) {
      return this.random.weighted([['QUALITY', 6], ['MAINTENANCE', 3], ['PROCESS', 1]]);
    }
    if (station.capability === CAPABILITIES.TORQUE) {
      return this.random.weighted([['TOOLING', 5], ['MAINTENANCE', 3], ['QUALITY', 2]]);
    }
    return this.random.weighted([
      ['MATERIAL', 5], ['MAINTENANCE', 3], ['PROCESS', 2], ['TOOLING', 1]
    ]);
  }

  symptomFor(callType) {
    return this.random.pick(SYMPTOMS[callType] || SYMPTOMS.PROCESS);
  }

  correctiveAction(callType) {
    return this.random.pick(CORRECTIVE_ACTIONS[callType] || CORRECTIVE_ACTIONS.PROCESS);
  }

  /**
   * Sensor readings for a station, shaped by what it physically does.
   * A stopped station reports idle values, not mid-cycle ones.
   */
  telemetryFor(station, state) {
    const running = state === 'RUNNING';
    const jitter = (mean, sd) => Number(this.random.normal(mean, sd).toFixed(2));

    const base = {
      state,
      cycleSeconds: running
        ? Number(this.random.normal(station.cycleSeconds * 1.03, station.cycleSeconds * 0.07).toFixed(1))
        : 0,
      ambientC: jitter(21.5, 1.2),
      // Air pressure sags when a big pneumatic station is mid-cycle.
      airPressureKpa: jitter(running ? 618 : 640, 9)
    };

    switch (station.capability) {
      case CAPABILITIES.WELD:
        return {
          ...base,
          weldCurrentA: running ? jitter(9800, 220) : 0,
          electrodeForceN: running ? jitter(3400, 90) : 0,
          tipWearPct: jitter(42, 18),
          weldsCompleted: running ? this.random.int(28, 46) : 0,
          robotAxisTempC: jitter(running ? 48 : 31, 4)
        };

      case CAPABILITIES.PAINT:
        return {
          ...base,
          boothHumidityPct: jitter(64, 3),
          boothTempC: jitter(23.5, 0.8),
          // Paint quality is extremely sensitive to booth conditions, which is
          // why these two are the readings a paint shop actually alarms on.
          flowRateMlMin: running ? jitter(255, 12) : 0,
          atomizerRpm: running ? jitter(42000, 1400) : 0,
          filmThicknessUm: running ? jitter(112, 6) : 0
        };

      case CAPABILITIES.TORQUE:
        return {
          ...base,
          lastTorqueNm: running ? jitter(station.torqueSpecs?.[0]?.nm || 110, 4) : 0,
          torqueAngleDeg: running ? jitter(92, 5) : 0,
          fastenersOk: running ? this.random.int(3, 8) : 0,
          fastenersRejected: running && this.random.chance(0.04) ? 1 : 0,
          toolBatteryPct: jitter(74, 16)
        };

      case CAPABILITIES.TEST:
        return {
          ...base,
          testDurationS: running ? jitter(station.cycleSeconds * 0.8, 4) : 0,
          measurementsTaken: running ? this.random.int(6, 24) : 0,
          passRatePct: jitter(97.4, 1.6),
          rigTempC: jitter(running ? 34 : 26, 3)
        };

      case CAPABILITIES.INSPECT:
        return {
          ...base,
          cameraExposureMs: jitter(12.4, 1.1),
          defectsFound: running && this.random.chance(0.18) ? this.random.int(1, 3) : 0,
          scanCoveragePct: jitter(99.2, 0.5),
          lightLevelLux: jitter(1180, 60)
        };

      default:
        return {
          ...base,
          partsConsumed: running ? this.random.int(1, 6) : 0,
          operatorPresent: running || this.random.chance(0.8),
          stationLoadPct: jitter(running ? 82 : 12, 9)
        };
    }
  }
}

module.exports = { FaultModel, SYMPTOMS, CORRECTIVE_ACTIONS };
