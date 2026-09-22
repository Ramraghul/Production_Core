'use strict';

/**
 * OpenAPI 3.0 specification, built from the live plant model.
 *
 * Generating the spec rather than hand-writing a YAML file means the example
 * values, enums and station identifiers in the documentation are always the
 * ones the running system actually accepts. A Swagger page that has drifted
 * from its implementation is worse than no Swagger page at all.
 */

const config = require('../config');
const pkg = require('../../package.json');
const plantModel = require('../core/plantModel');
const quality = require('../core/quality');
const downtimeCore = require('../core/downtime');
const andonCore = require('../core/andon');
const workOrderCore = require('../core/workOrder');
const unitCore = require('../core/unit');
const subCore = require('../core/subAssembly');
const controlCore = require('../core/stationControl');
const { isLocalOrigin } = require('./origin');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** A JSON response body. */
const json = (description, schema, example) => ({
  description,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } }
});

/** A query, path or header parameter. */
const param = (name, where, description, schema = { type: 'string' }, example) => ({
  name, in: where, description, required: where === 'path', schema, ...(example ? { example } : {})
});

const PAGE_PARAMS = [
  param('limit', 'query', 'Maximum items to return (1-500).', { type: 'integer', minimum: 1, maximum: 500, default: 50 }),
  param('offset', 'query', 'Items to skip, for paging.', { type: 'integer', minimum: 0, default: 0 }),
  param('sort', 'query', 'Field to sort by.'),
  param('order', 'query', 'Sort direction.', { type: 'string', enum: ['asc', 'desc'], default: 'desc' })
];

const ERROR_RESPONSES = {
  400: json('The request failed validation.', ref('Error')),
  401: json('A valid API key is required for this operation.', ref('Error')),
  404: json('The requested resource does not exist.', ref('Error')),
  409: json('The operation conflicts with the current state of the resource.', ref('Error')),
  429: json('Too many state-changing requests from this client; see Retry-After.', ref('Error'))
};

/**
 * Every state-changing operation can be rate-limited, so each one documents
 * the 429 rather than relying on each path definition to remember it.
 */
function withRateLimitResponses(paths) {
  for (const operations of Object.values(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (method === 'get' || !operation.responses) continue;
      operation.responses[429] = operation.responses[429] || ERROR_RESPONSES[429];
    }
  }
  return paths;
}

/**
 * Build the specification.
 * @param {object} [options]
 * @param {string} [options.origin]    where the document is being read from
 * @param {string} [options.publicUrl] fallback when there is no request
 */
function buildSpec(options = {}) {
  const stationIds = plantModel.ALL_STATIONS.map((s) => s.id);
  const lineIds = plantModel.LINES.map((l) => l.id);
  const modelCodes = plantModel.MODELS.map((m) => m.code);
  const exampleStation = 'CHAS-10';
  const exampleVin = '2NSAURE1XTW001042';

  // Exactly one server: the address the document is being read from. On the
  // live site Swagger shows only the live URL, on a developer's machine only
  // localhost - offering both invites "Try it out" against the wrong one.
  const origin = (options.origin || options.publicUrl || config.http.publicUrl
    || `http://localhost:${config.http.port}`).replace(/\/+$/, '');
  const servers = [{
    url: `${origin}/api/v1`,
    description: isLocalOrigin(origin) ? 'Local - this machine' : 'Live deployment'
  }];

  return {
    openapi: '3.0.3',
    info: {
      title: 'Production Core - Vehicle Assembly MES API',
      version: pkg.version,
      description: [
        'REST API for **Production Core**, an end-to-end Manufacturing Execution System for a',
        'vehicle assembly plant, built on Node-RED.',
        '',
        `The simulated plant is **${config.site.enterprise} / ${config.site.name}**`,
        `(${config.site.location}) - ${plantModel.LINES.length} production lines and`,
        `${plantModel.ALL_STATIONS.length} stations covering body shop, paint, door line,`,
        'wheel & tire, sub-assembly, main assembly and end-of-line quality.',
        '',
        '### What this API is for',
        '',
        '| Area | Endpoints | What it does |',
        '| --- | --- | --- |',
        '| Plant model | `/plant`, `/lines`, `/stations` | ISA-95 hierarchy and live station state |',
        '| Scheduling | `/work-orders` | Create, release and track build orders |',
        '| Execution | `/units` | Move vehicles through the routing, enforce the sequence |',
        '| Feeder lines | `/sub-assemblies` | Serialised modules and buffer levels |',
        '| Quality | `/quality/*` | Inspection plans, defects, dispositions, gates |',
        '| Floor ops | `/andon`, `/downtime` | Line-stop calls and ISO 22400 downtime reasons |',
        '| Station control | `/stations/{id}/start` `/stop` `/maintenance` | Operator lockout and maintenance orders |',
        '| KPIs | `/kpi/*` | OEE, FPY, throughput and shift trend (ISO 22400-2) |',
        '| Traceability | `/trace/*` | As-built genealogy and supplier-lot recall analysis |',
        '| Streaming | `/events/stream` | Server-sent event feed of everything happening |',
        '',
        '### Authentication',
        '',
        'Read endpoints are open so this demo is browsable. Any request that changes plant',
        'state needs an API key in the `x-api-key` header. On the public demo the key is',
        `\`${config.security.apiKey}\` - click **Authorize** above and paste it in.`,
        '',
        '### Try the interesting one first',
        '',
        'Run `GET /trace/lots` to list supplier batches, then `POST /trace/recall` with one of',
        'them. That is the query an MES exists to answer: which vehicles contain a suspect part,',
        'where are they now, and how much does containment cost.'
      ].join('\n'),
      contact: { name: 'Production Core', url: 'https://github.com/' },
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' }
    },
    servers,
    externalDocs: {
      description: 'Architecture, domain model and deployment notes',
      url: '/docs/ARCHITECTURE.md'
    },
    tags: [
      { name: 'System', description: 'Health, readiness and runtime diagnostics' },
      { name: 'Plant', description: 'ISA-95 plant hierarchy and reference data' },
      { name: 'Work Orders', description: 'Production scheduling' },
      { name: 'Units', description: 'Vehicle execution and routing' },
      { name: 'Sub-Assemblies', description: 'Serialised feeder-line modules' },
      { name: 'Quality', description: 'Inspections, defects and quality gates' },
      { name: 'Station Control', description: 'Operator start/stop with lockout, and maintenance orders' },
      { name: 'Andon', description: 'Line-stop calls and escalation' },
      { name: 'Downtime', description: 'Stoppage capture with ISO 22400 reason codes' },
      { name: 'KPI', description: 'OEE and production performance' },
      { name: 'Traceability', description: 'Genealogy and recall analysis' },
      { name: 'Events', description: 'Event log and live stream' },
      { name: 'Simulator', description: 'Drive the simulated plant' }
    ],

    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey', in: 'header', name: 'x-api-key',
          description: 'Required for all state-changing (POST/PATCH/DELETE) requests.'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'Stable machine-readable identifier.',
                  enum: [
                    'VALIDATION_FAILED', 'NOT_FOUND', 'INVALID_STATE_TRANSITION',
                    'CONFLICT', 'UNAUTHORIZED', 'QUALITY_HOLD', 'ROUTE_NOT_FOUND',
                    'MALFORMED_JSON', 'INTERNAL_ERROR'
                  ]
                },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true }
              },
              required: ['code', 'message']
            },
            requestId: { type: 'string' }
          },
          example: {
            error: {
              code: 'QUALITY_HOLD',
              message: `Unit ${exampleVin} is held at BODY-50 by 1 open defect(s)`,
              details: { vin: exampleVin, station: 'BODY-50' }
            }
          }
        },

        Station: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: stationIds },
            name: { type: 'string' },
            lineId: { type: 'string', enum: lineIds },
            sequence: { type: 'integer' },
            capability: { type: 'string', enum: Object.keys(plantModel.CAPABILITIES) },
            cycleSeconds: { type: 'number', description: 'Ideal cycle time (ISO 22400 ICT).' },
            qualityGate: { type: 'boolean', description: 'Blocks units carrying open defects.' },
            criticalToQuality: { type: 'boolean' },
            producesSerial: { type: 'string', nullable: true },
            consumesSerial: { type: 'array', items: { type: 'string' } }
          }
        },

        StationState: {
          type: 'object',
          properties: {
            stationId: { type: 'string' },
            stationName: { type: 'string' },
            lineId: { type: 'string' },
            state: { type: 'string', enum: Object.keys(plantModel.STATION_STATES) },
            previousState: { type: 'string', nullable: true },
            since: { type: 'string', format: 'date-time' },
            currentVin: { type: 'string', nullable: true },
            cycleCount: { type: 'integer' },
            goodCount: { type: 'integer' },
            lastCycleSeconds: { type: 'number', nullable: true },
            idealCycleSeconds: { type: 'number' },
            openDowntimeId: { type: 'string', nullable: true }
          }
        },

        WorkOrder: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'WO-2026-0042' },
            modelCode: { type: 'string', enum: modelCodes },
            modelName: { type: 'string' },
            colour: { type: 'string' },
            quantity: { type: 'integer', minimum: 1, maximum: 2000 },
            quantityStarted: { type: 'integer' },
            quantityCompleted: { type: 'integer' },
            quantityScrapped: { type: 'integer' },
            priority: { type: 'string', enum: workOrderCore.PRIORITIES },
            status: { type: 'string', enum: Object.keys(workOrderCore.WORK_ORDER_STATES) },
            customerRef: { type: 'string', nullable: true },
            dueDate: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },

        WorkOrderCreate: {
          type: 'object',
          required: ['modelCode', 'quantity'],
          properties: {
            id: { type: 'string', description: 'Optional. Generated when omitted.' },
            modelCode: { type: 'string', enum: modelCodes },
            quantity: { type: 'integer', minimum: 1, maximum: 2000 },
            colour: { type: 'string', description: 'Must be a colour offered for the model.' },
            priority: { type: 'string', enum: workOrderCore.PRIORITIES, default: 'NORMAL' },
            dueDate: { type: 'string', format: 'date-time' },
            customerRef: { type: 'string' }
          },
          example: {
            modelCode: 'NS-AURORA-EV',
            quantity: 48,
            colour: 'Laurentian Blue',
            priority: 'HIGH',
            customerRef: 'ORD-884210'
          }
        },

        Unit: {
          type: 'object',
          description: 'One physical vehicle moving through the plant.',
          properties: {
            vin: { type: 'string', description: 'ISO 3779 VIN with a valid check digit.', example: exampleVin },
            workOrderId: { type: 'string' },
            modelCode: { type: 'string', enum: modelCodes },
            colour: { type: 'string' },
            buildNumber: { type: 'integer', nullable: true },
            status: { type: 'string', enum: Object.keys(unitCore.UNIT_STATES) },
            currentStation: { type: 'string', nullable: true },
            currentLine: { type: 'string', nullable: true },
            progressPct: { type: 'number' },
            openDefects: { type: 'integer' },
            reworkCount: { type: 'integer' },
            firstPass: { type: 'boolean', description: 'Cleared every station without rework.' }
          }
        },

        SubAssembly: {
          type: 'object',
          properties: {
            serial: { type: 'string', example: 'PWT-26259-000412' },
            classCode: { type: 'string', enum: Object.keys(plantModel.SERIAL_COMPONENTS) },
            description: { type: 'string' },
            buildMode: { type: 'string', enum: Object.keys(subCore.BUILD_MODES) },
            status: { type: 'string', enum: Object.keys(subCore.SUB_STATES) },
            builtAt: { type: 'string' },
            installsAt: { type: 'string', nullable: true },
            forVin: { type: 'string', nullable: true },
            consumedByVin: { type: 'string', nullable: true },
            components: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },

        Defect: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'DEF-000317' },
            code: { type: 'string', enum: quality.DEFECT_CODES.map((d) => d.code) },
            family: { type: 'string' },
            severity: { type: 'string', enum: Object.keys(quality.SEVERITIES) },
            status: { type: 'string', enum: Object.keys(quality.DEFECT_STATES) },
            vin: { type: 'string', nullable: true },
            stationId: { type: 'string' },
            lineId: { type: 'string', nullable: true },
            disposition: { type: 'string', enum: Object.keys(quality.DISPOSITIONS), nullable: true },
            suspectLotCode: { type: 'string', nullable: true }
          }
        },

        Inspection: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            planId: { type: 'string', enum: Object.keys(quality.INSPECTION_PLANS) },
            stationId: { type: 'string' },
            subject: { type: 'string', description: 'VIN or sub-assembly serial.' },
            passed: { type: 'boolean' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  characteristicId: { type: 'string' },
                  value: { type: 'number' },
                  lowerLimit: { type: 'number' },
                  upperLimit: { type: 'number' },
                  inSpec: { type: 'boolean' },
                  deviation: { type: 'number' }
                }
              }
            },
            defectCodes: { type: 'array', items: { type: 'string' } }
          }
        },

        InspectionCreate: {
          type: 'object',
          required: ['measurements'],
          properties: {
            planId: { type: 'string', enum: Object.keys(quality.INSPECTION_PLANS) },
            stationId: { type: 'string', enum: stationIds, description: 'Used to look up the plan when planId is omitted.' },
            vin: { type: 'string' },
            serial: { type: 'string' },
            inspector: { type: 'string' },
            measurements: {
              type: 'object',
              additionalProperties: { type: 'number' },
              description: 'One value per characteristic in the plan. All are required.'
            }
          },
          example: {
            stationId: 'EOL-10',
            vin: exampleVin,
            inspector: 'qa-201',
            measurements: { 'TOE-FRONT': 0.42, 'CAMBER-FRONT': -0.5, 'THRUST-ANGLE': 0.02 }
          }
        },

        StationControl: {
          type: 'object',
          description: 'Everything a control panel needs for one station. Returned by every control action.',
          properties: {
            stationId: { type: 'string' },
            state: { type: 'string', enum: Object.keys(plantModel.STATION_STATES) },
            control: {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: Object.keys(controlCore.CONTROL_MODES) },
                since: { type: 'string', format: 'date-time' },
                by: { type: 'string' },
                reason: { type: 'string', nullable: true },
                reasonCode: { type: 'string', nullable: true },
                maintenanceOrderId: { type: 'string', nullable: true }
              }
            },
            locked: { type: 'boolean', description: 'Automated state changes are refused while true.' },
            allowedActions: { type: 'array', items: { type: 'string', enum: Object.values(controlCore.ACTIONS) } },
            blockedActions: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Why each unavailable action is unavailable, keyed by action.'
            },
            pm: {
              type: 'object',
              properties: {
                intervalCycles: { type: 'integer' },
                cyclesSinceMaintenance: { type: 'integer' },
                usedPct: { type: 'number' },
                remainingCycles: { type: 'integer' },
                status: { type: 'string', enum: ['OK', 'DUE_SOON', 'DUE', 'OVERDUE'] }
              }
            },
            activeMaintenance: { allOf: [ref('MaintenanceOrder')], nullable: true }
          }
        },

        MaintenanceOrder: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'MWO-000042' },
            stationId: { type: 'string' },
            type: { type: 'string', enum: Object.keys(controlCore.MAINTENANCE_TYPES) },
            planned: { type: 'boolean', description: 'Planned work comes out of planned busy time rather than availability.' },
            status: { type: 'string', enum: Object.keys(controlCore.ORDER_STATES) },
            technician: { type: 'string' },
            plannedMinutes: { type: 'number' },
            actualMinutes: { type: 'number', nullable: true },
            overrunMinutes: { type: 'number', nullable: true },
            checklist: {
              type: 'array',
              items: { type: 'object', properties: { task: { type: 'string' }, done: { type: 'boolean' } } }
            },
            checklistComplete: { type: 'boolean' },
            findings: { type: 'string', nullable: true },
            downtimeId: { type: 'string', nullable: true },
            andonId: { type: 'string', nullable: true },
            startedAt: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', format: 'date-time', nullable: true }
          }
        },

        Andon: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'AND-000118' },
            stationId: { type: 'string' },
            lineId: { type: 'string' },
            callType: { type: 'string', enum: Object.keys(andonCore.CALL_TYPES) },
            label: { type: 'string' },
            colour: { type: 'string', enum: ['red', 'amber', 'blue'] },
            stopsLine: { type: 'boolean' },
            slaSeconds: { type: 'integer' },
            status: { type: 'string', enum: Object.keys(andonCore.ANDON_STATES) },
            escalationTier: { type: 'integer' },
            responseSeconds: { type: 'integer', nullable: true },
            slaMet: { type: 'boolean', nullable: true }
          }
        },

        AndonCreate: {
          type: 'object',
          required: ['stationId', 'callType'],
          properties: {
            stationId: { type: 'string', enum: stationIds },
            callType: { type: 'string', enum: Object.keys(andonCore.CALL_TYPES) },
            raisedBy: { type: 'string' },
            vin: { type: 'string' },
            note: { type: 'string' }
          },
          example: {
            stationId: exampleStation,
            callType: 'MAINTENANCE',
            raisedBy: 'op-4408',
            note: 'Decking fixture will not clamp'
          }
        },

        Downtime: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            stationId: { type: 'string' },
            lineId: { type: 'string' },
            reasonCode: { type: 'string', enum: downtimeCore.REASON_CODES.map((r) => r.code) },
            reasonLabel: { type: 'string' },
            category: { type: 'string', enum: Object.keys(downtimeCore.DOWNTIME_CATEGORIES) },
            bigLoss: { type: 'string', nullable: true, enum: [...Object.keys(downtimeCore.BIG_LOSSES), null] },
            startedAt: { type: 'string', format: 'date-time' },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            durationSeconds: { type: 'integer', nullable: true },
            rootCause: { type: 'string', nullable: true }
          }
        },

        Oee: {
          type: 'object',
          description: 'ISO 22400-2 overall equipment effectiveness. All values are percentages.',
          properties: {
            availability: { type: 'number', description: 'Actual production time / planned busy time.' },
            performance: { type: 'number', description: 'Ideal cycle x count / actual production time. Capped at 100.' },
            quality: { type: 'number', description: 'First-pass good count / total count.' },
            oee: { type: 'number', description: 'availability x performance x quality.' },
            teep: { type: 'number', description: 'OEE measured against all 24 hours.' },
            rating: { type: 'string', enum: ['WORLD_CLASS', 'GOOD', 'ACCEPTABLE', 'NEEDS_ATTENTION'] },
            losses: {
              type: 'object',
              description: 'Where the shift went, in seconds. Sums back to net planned time.',
              properties: {
                availabilityLossSeconds: { type: 'integer' },
                performanceLossSeconds: { type: 'integer' },
                qualityLossSeconds: { type: 'integer' },
                valueAddingSeconds: { type: 'integer' }
              }
            },
            warnings: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },

        RecallQuery: {
          type: 'object',
          description: 'Supply exactly one of lotCode, serial or partNumber.',
          properties: {
            lotCode: { type: 'string', description: 'Supplier batch code.', example: 'BREMBO-PN-BRAKE-FRONT-2638B' },
            serial: { type: 'string', description: 'Serialised sub-assembly.' },
            partNumber: { type: 'string', description: 'Every vehicle containing this part.' },
            reason: { type: 'string', description: 'Recorded on the audit event.' }
          },
          example: { lotCode: 'BREMBO-PN-BRAKE-FRONT-2638B', reason: 'Supplier quality alert 2026-09-16' }
        },

        RecallReport: {
          type: 'object',
          properties: {
            affectedCount: { type: 'integer' },
            byContainment: {
              type: 'object',
              description: 'Where the affected vehicles are now. IN_PLANT is the cheap column.',
              properties: {
                IN_PLANT: { type: 'integer' },
                FINISHED_GOODS: { type: 'integer' },
                SHIPPED: { type: 'integer' },
                SCRAPPED: { type: 'integer' }
              }
            },
            supplier: { type: 'string', nullable: true },
            safetyCritical: { type: 'boolean' },
            containableNow: { type: 'integer' },
            estimatedRecallCostCad: { type: 'number' },
            recommendation: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['NO_ACTION', 'CONTAIN_IN_PLANT', 'FIELD_CAMPAIGN', 'SAFETY_RECALL'] },
                rationale: { type: 'string' }
              }
            },
            affected: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },

        Genealogy: {
          type: 'object',
          description: 'As-built record. Append-only, and sealed when the vehicle is released.',
          properties: {
            vin: { type: 'string' },
            components: {
              type: 'array',
              description: 'Tree of parts and sub-assemblies, each with its supplier lot.',
              items: { type: 'object', additionalProperties: true }
            },
            lotIndex: { type: 'array', items: { type: 'string' } },
            serialIndex: { type: 'array', items: { type: 'string' } },
            sealedAt: { type: 'string', format: 'date-time', nullable: true },
            stats: { type: 'object', additionalProperties: true }
          }
        },

        Event: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', example: 'unit.moved' },
            timestamp: { type: 'string', format: 'date-time' },
            severity: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
            stationId: { type: 'string', nullable: true },
            lineId: { type: 'string', nullable: true },
            vin: { type: 'string', nullable: true },
            payload: { type: 'object', additionalProperties: true }
          }
        },

        Collection: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' }
          }
        }
      }
    },

    paths: withRateLimitResponses(buildPaths({ stationIds, lineIds, modelCodes, exampleVin, exampleStation }))
  };
}

function buildPaths({ stationIds, lineIds, modelCodes, exampleVin, exampleStation }) {
  const secured = [{ ApiKeyAuth: [] }];

  return {
    // ---- System ----------------------------------------------------------
    '/health': {
      get: {
        tags: ['System'], summary: 'Service health and runtime diagnostics',
        description: 'Includes store collection sizes, simulator state and MQTT broker state. Useful as a PaaS health check.',
        responses: { 200: json('Service is healthy.', { type: 'object', additionalProperties: true }) }
      }
    },
    '/live': {
      get: { tags: ['System'], summary: 'Liveness probe', responses: { 200: json('Process is alive.', { type: 'object' }) } }
    },
    '/ready': {
      get: {
        tags: ['System'], summary: 'Readiness probe',
        description: 'Returns 503 until the plant model and station states are loaded.',
        responses: {
          200: json('Ready to serve traffic.', { type: 'object' }),
          503: json('Still starting up.', { type: 'object' })
        }
      }
    },

    // ---- Plant -----------------------------------------------------------
    '/plant': {
      get: {
        tags: ['Plant'], summary: 'ISA-95 plant hierarchy',
        description: 'Enterprise > Site > Area > Line > Station, with takt times, capacity and the design bottleneck of each line.',
        responses: { 200: json('The full plant model.', { type: 'object', additionalProperties: true }) }
      }
    },
    '/lines': {
      get: { tags: ['Plant'], summary: 'List production lines', responses: { 200: json('All lines.', ref('Collection')) } }
    },
    '/lines/{lineId}': {
      get: {
        tags: ['Plant'], summary: 'Get one line with its stations',
        parameters: [param('lineId', 'path', 'Line identifier.', { type: 'string', enum: lineIds })],
        responses: { 200: json('The line.', { type: 'object', additionalProperties: true }), 404: ERROR_RESPONSES[404] }
      }
    },
    '/lines/{lineId}/oee': {
      get: {
        tags: ['KPI'], summary: 'OEE for a line',
        description: 'Rolled up from its stations: availability and performance come from the constraint station, quality compounds along the route.',
        parameters: [
          param('lineId', 'path', 'Line identifier.', { type: 'string', enum: lineIds }),
          param('since', 'query', 'Window start (ISO-8601). Defaults to the current shift.', { type: 'string', format: 'date-time' }),
          param('until', 'query', 'Window end (ISO-8601).', { type: 'string', format: 'date-time' })
        ],
        responses: { 200: json('Line OEE.', ref('Oee')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/stations': {
      get: {
        tags: ['Plant'], summary: 'List stations with live state',
        parameters: [param('lineId', 'query', 'Filter to one line.', { type: 'string', enum: lineIds })],
        responses: { 200: json('Stations and their current state.', ref('Collection')) }
      }
    },
    '/stations/{stationId}': {
      get: {
        tags: ['Plant'], summary: 'Get a station',
        description: 'Includes the parts it back-flushes and its inspection plan, if it is a gate.',
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        responses: { 200: json('The station.', ref('Station')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/stations/{stationId}/state': {
      post: {
        tags: ['Plant'], summary: 'Change a station state', security: secured,
        description: 'Moving into DOWN, STARVED, BLOCKED, MAINTENANCE or CHANGEOVER opens a downtime record automatically; moving out closes it.',
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['state'],
                properties: {
                  state: { type: 'string', enum: Object.keys(plantModel.STATION_STATES) },
                  reasonCode: { type: 'string', enum: downtimeCore.REASON_CODES.map((r) => r.code) },
                  reason: { type: 'string' },
                  operator: { type: 'string' }
                }
              },
              example: { state: 'DOWN', reasonCode: 'ROBOT_FAULT', reason: 'Servo drive over-temperature', operator: 'op-4408' }
            }
          }
        },
        responses: { 200: json('Updated station state.', ref('StationState')), ...ERROR_RESPONSES }
      }
    },
    '/stations/{stationId}/control': {
      get: {
        tags: ['Station Control'], summary: 'Control view for a station',
        description: 'State, control mode, the operator actions currently legal and why the others are not, PM status and any open maintenance order. The HMI renders its buttons from `allowedActions`.',
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        responses: { 200: json('Control view.', ref('StationControl')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/stations/{stationId}/stop': {
      post: {
        tags: ['Station Control'], summary: 'Stop a station (operator lockout)', security: secured,
        description: [
          'The station holds whatever vehicle it has and **stays stopped**: automated state changes - the simulator, a flow, a PLC over MQTT - are refused until someone starts it. Vehicles cannot be moved into it without `force`.',
          '',
          'The reason code decides the OEE consequence: `SCHEDULED_BREAK` or `SHIFT_MEETING` are planned and come out of planned busy time; the default `OPERATOR_STOP` is an availability loss.'
        ].join('\n'),
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { operator: { type: 'string' }, reasonCode: { type: 'string', enum: downtimeCore.REASON_CODES.map((r) => r.code), default: 'OPERATOR_STOP' }, reason: { type: 'string' } } }, example: { operator: 'op-2271', reasonCode: 'SCHEDULED_BREAK', reason: 'Lunch relief' } } }
        },
        responses: { 200: json('Stopped.', ref('StationControl')), ...ERROR_RESPONSES }
      }
    },
    '/stations/{stationId}/start': {
      post: {
        tags: ['Station Control'], summary: 'Start a station', security: secured,
        description: 'From an operator stop, or from a fault once nothing is holding it down. A station down on an open line-stopping andon returns 409 - resolve the call, which is where the response time is recorded. A station under maintenance returns 409 - complete the order.',
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { operator: { type: 'string' }, note: { type: 'string' } } }, example: { operator: 'op-2271' } } } },
        responses: { 200: json('Back in service.', ref('StationControl')), ...ERROR_RESPONSES }
      }
    },
    '/stations/{stationId}/maintenance': {
      get: {
        tags: ['Station Control'], summary: 'Maintenance status and history for a station',
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        responses: { 200: json('PM status, active order, checklist and history.', { type: 'object', additionalProperties: true }), 404: ERROR_RESPONSES[404] }
      },
      post: {
        tags: ['Station Control'], summary: 'Start maintenance', security: secured,
        description: [
          'Opens a maintenance order and locks the station. Downtime is booked by type:',
          '',
          '| Type | Downtime | OEE |',
          '| --- | --- | --- |',
          '| `PREVENTIVE`, `PREDICTIVE` | `PREVENTIVE_MAINT`, planned | out of planned busy time |',
          '| `CORRECTIVE` | keeps the failure downtime if the station is down, else `EQUIP_FAILURE` | availability loss, counts for MTBF/MTTR |',
          '',
          'Type defaults to `CORRECTIVE` for a station that is down and `PREVENTIVE` otherwise.'
        ].join('\n'),
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { type: { type: 'string', enum: Object.keys(controlCore.MAINTENANCE_TYPES) }, technician: { type: 'string' }, plannedMinutes: { type: 'number', minimum: 1, maximum: 480 }, note: { type: 'string' } } }, example: { type: 'PREVENTIVE', technician: 'maint-771', plannedMinutes: 20, note: 'Scheduled PM' } } }
        },
        responses: { 201: json('Maintenance started.', ref('StationControl')), ...ERROR_RESPONSES }
      }
    },
    '/stations/{stationId}/maintenance/complete': {
      post: {
        tags: ['Station Control'], summary: 'Complete maintenance and return to service', security: secured,
        description: 'Signs the order off, closes its downtime, resets the PM counter and - if the work answered an andon call - resolves that call too. `checklist` lists the tasks done; anything omitted is recorded as not done, which is how an audit finds a skipped step.',
        parameters: [param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds })],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { technician: { type: 'string' }, findings: { type: 'string' }, partsReplaced: { type: 'array', items: { type: 'string' } }, checklist: { type: 'array', items: { type: 'string' } } } }, example: { technician: 'maint-771', findings: 'Bell cup worn; replaced', partsReplaced: ['PN-BELL-CUP'] } } }
        },
        responses: { 200: json('Completed; includes `completedOrder`.', ref('StationControl')), ...ERROR_RESPONSES }
      }
    },
    '/stations/{stationId}/oee': {
      get: {
        tags: ['KPI'], summary: 'OEE for a station',
        parameters: [
          param('stationId', 'path', 'Station identifier.', { type: 'string', enum: stationIds }),
          param('since', 'query', 'Window start. Defaults to the current shift.', { type: 'string', format: 'date-time' })
        ],
        responses: { 200: json('Station OEE with the loss waterfall.', ref('Oee')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/models': { get: { tags: ['Plant'], summary: 'Vehicle models this plant is tooled for', responses: { 200: json('Models.', ref('Collection')) } } },
    '/parts': {
      get: {
        tags: ['Plant'], summary: 'Part master',
        parameters: [
          param('supplier', 'query', 'Filter by supplier code.'),
          param('lotControlled', 'query', 'Only lot-controlled parts.', { type: 'boolean' }),
          param('safetyCritical', 'query', 'Only safety-critical parts.', { type: 'boolean' })
        ],
        responses: { 200: json('Parts.', ref('Collection')) }
      }
    },
    '/boms/{modelCode}': {
      get: {
        tags: ['Plant'], summary: 'Multi-level bill of materials for a model',
        parameters: [param('modelCode', 'path', 'Model code.', { type: 'string', enum: modelCodes })],
        responses: { 200: json('The BOM, derived from the routing.', { type: 'object', additionalProperties: true }), 404: ERROR_RESPONSES[404] }
      }
    },
    '/shifts': { get: { tags: ['Plant'], summary: 'Shift calendar and the current shift window', responses: { 200: json('Shifts.', { type: 'object' }) } } },
    '/reference/defect-codes': {
      get: {
        tags: ['Quality'], summary: 'Defect code catalogue',
        parameters: [param('family', 'query', 'Filter by family.', { type: 'string', enum: ['BODY', 'PAINT', 'ASSEMBLY', 'ELECTRICAL', 'TRIM', 'FUNCTIONAL'] })],
        responses: { 200: json('Defect codes.', ref('Collection')) }
      }
    },
    '/reference/downtime-reasons': {
      get: {
        tags: ['Downtime'], summary: 'Downtime reason codes with Six Big Losses mapping',
        parameters: [param('category', 'query', 'Planned or unplanned.', { type: 'string', enum: ['PLANNED', 'UNPLANNED'] })],
        responses: { 200: json('Reason codes.', ref('Collection')) }
      }
    },
    '/reference/andon-types': { get: { tags: ['Andon'], summary: 'Andon call types, SLAs and escalation tiers', responses: { 200: json('Call types.', { type: 'object' }) } } },
    '/reference/inspection-plans': { get: { tags: ['Quality'], summary: 'Inspection plans and their characteristics', responses: { 200: json('Plans.', ref('Collection')) } } },

    // ---- Work orders ------------------------------------------------------
    '/work-orders': {
      get: {
        tags: ['Work Orders'], summary: 'List work orders',
        parameters: [
          param('status', 'query', 'Filter by status.', { type: 'string', enum: Object.keys(workOrderCore.WORK_ORDER_STATES) }),
          param('modelCode', 'query', 'Filter by model.', { type: 'string', enum: modelCodes }),
          ...PAGE_PARAMS
        ],
        responses: { 200: json('Work orders.', ref('Collection')) }
      },
      post: {
        tags: ['Work Orders'], summary: 'Create a work order', security: secured,
        description: 'Created in DRAFT. Release it to mint vehicles and VINs.',
        requestBody: { required: true, content: { 'application/json': { schema: ref('WorkOrderCreate') } } },
        responses: { 201: json('Created.', ref('WorkOrder')), ...ERROR_RESPONSES }
      }
    },
    '/work-orders/{id}': {
      get: {
        tags: ['Work Orders'], summary: 'Get a work order with progress and its units',
        parameters: [param('id', 'path', 'Work order id.')],
        responses: { 200: json('The work order.', ref('WorkOrder')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/work-orders/{id}/release': {
      post: {
        tags: ['Work Orders'], summary: 'Release to the floor', security: secured,
        description: 'Creates one vehicle per planned unit, each with a check-digit-valid VIN and an open genealogy record.',
        parameters: [param('id', 'path', 'Work order id.')],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { createUnits: { type: 'integer', description: 'Create fewer units than the order quantity.' } } }, example: { createUnits: 10 } } }
        },
        responses: { 200: json('Released, with the units created.', { type: 'object', additionalProperties: true }), ...ERROR_RESPONSES }
      }
    },
    '/work-orders/{id}/transition': {
      post: {
        tags: ['Work Orders'], summary: 'Change work order status', security: secured,
        parameters: [param('id', 'path', 'Work order id.')],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: Object.keys(workOrderCore.WORK_ORDER_STATES) }, reason: { type: 'string' } } }, example: { status: 'ON_HOLD', reason: 'Awaiting seat delivery' } } }
        },
        responses: { 200: json('Updated.', ref('WorkOrder')), ...ERROR_RESPONSES }
      }
    },

    // ---- Units ------------------------------------------------------------
    '/units': {
      get: {
        tags: ['Units'], summary: 'List vehicles',
        parameters: [
          param('status', 'query', 'Filter by status.', { type: 'string', enum: Object.keys(unitCore.UNIT_STATES) }),
          param('lineId', 'query', 'Vehicles on this line.', { type: 'string', enum: lineIds }),
          param('stationId', 'query', 'Vehicles at this station.', { type: 'string', enum: stationIds }),
          param('workOrderId', 'query', 'Vehicles from this work order.'),
          ...PAGE_PARAMS
        ],
        responses: { 200: json('Vehicles.', ref('Collection')) }
      }
    },
    '/units/wip': { get: { tags: ['Units'], summary: 'Vehicles currently on the floor', responses: { 200: json('Work in progress.', ref('Collection')) } } },
    '/units/{vin}': {
      get: {
        tags: ['Units'], summary: 'Get a vehicle',
        parameters: [param('vin', 'path', 'Vehicle identification number.', { type: 'string' }, exampleVin)],
        responses: { 200: json('The vehicle.', ref('Unit')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/units/{vin}/history': {
      get: {
        tags: ['Units'], summary: 'Station-by-station build history',
        description: 'Every visit with dwell time, cycle time and variance against the ideal, plus the remaining route.',
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        responses: { 200: json('Build history.', { type: 'object', additionalProperties: true }), 404: ERROR_RESPONSES[404] }
      }
    },
    '/units/{vin}/genealogy': {
      get: {
        tags: ['Traceability'], summary: 'As-built genealogy for a vehicle',
        description: 'The full component tree: parts with supplier lot codes, serialised sub-assemblies, and the parts inside those.',
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        responses: { 200: json('Genealogy.', ref('Genealogy')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/units/{vin}/move': {
      post: {
        tags: ['Units'], summary: 'Move a vehicle to a station', security: secured,
        description: [
          'Enforces the routing: a vehicle cannot skip stations unless `force` is set, which is recorded as an override.',
          'Moving off a quality-gate station fails with 409 QUALITY_HOLD while the vehicle carries an open CRITICAL or undispositioned MAJOR defect.',
          'Also back-flushes the parts consumed at the target station and installs any sub-assembly it is due to fit.'
        ].join('\n\n'),
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['stationId'], properties: { stationId: { type: 'string', enum: stationIds }, operator: { type: 'string' }, force: { type: 'boolean', default: false }, result: { type: 'string', enum: Object.keys(unitCore.VISIT_RESULTS) } } }, example: { stationId: exampleStation, operator: 'op-2271' } } }
        },
        responses: { 200: json('Moved.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },
    '/units/{vin}/advance': {
      post: {
        tags: ['Units'], summary: 'Advance to the next station on the route', security: secured,
        description: 'Completes the vehicle when it is already at the end of the line.',
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        responses: { 200: json('Advanced.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },
    '/units/{vin}/hold': {
      post: {
        tags: ['Units'], summary: 'Put a vehicle on hold', security: secured,
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' }, operator: { type: 'string' } } }, example: { reason: 'Suspect brake lot pending disposition', operator: 'qa-201' } } } },
        responses: { 200: json('Held.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },
    '/units/{vin}/rework': {
      post: {
        tags: ['Units'], summary: 'Send a vehicle to rework', security: secured,
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' }, operator: { type: 'string' } } } } } },
        responses: { 200: json('Sent to rework.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },
    '/units/{vin}/release': {
      post: {
        tags: ['Units'], summary: 'Return a held or reworked vehicle to the line', security: secured,
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        responses: { 200: json('Released back to the line.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },
    '/units/{vin}/complete': {
      post: {
        tags: ['Units'], summary: 'Release the vehicle to the yard', security: secured,
        description: 'Only legal from the end-of-line release station with no open defects. Seals the genealogy record and increments the work order.',
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        responses: { 200: json('Vehicle released.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },
    '/units/{vin}/scrap': {
      post: {
        tags: ['Units'], summary: 'Scrap a vehicle', security: secured,
        description: 'Terminal and irreversible, as in a real plant.',
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' }, operator: { type: 'string' } } }, example: { reason: 'Unrecoverable dimensional defect at BODY-50', operator: 'qa-203' } } } },
        responses: { 200: json('Scrapped.', ref('Unit')), ...ERROR_RESPONSES }
      }
    },

    // ---- Sub-assemblies ---------------------------------------------------
    '/sub-assemblies': {
      get: {
        tags: ['Sub-Assemblies'], summary: 'List serialised sub-assemblies',
        parameters: [
          param('classCode', 'query', 'Component class.', { type: 'string', enum: Object.keys(plantModel.SERIAL_COMPONENTS) }),
          param('status', 'query', 'Filter by status.', { type: 'string', enum: Object.keys(subCore.SUB_STATES) }),
          param('consumedByVin', 'query', 'Serials fitted to this VIN.'),
          ...PAGE_PARAMS
        ],
        responses: { 200: json('Sub-assemblies.', ref('Collection')) }
      },
      post: {
        tags: ['Sub-Assemblies'], summary: 'Build a sub-assembly', security: secured,
        description: 'Back-flushes the cell\'s parts, records its functional test, and places it in the buffer. Door sets are broadcast-built and require forVin.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['classCode'], properties: { classCode: { type: 'string', enum: Object.keys(plantModel.SERIAL_COMPONENTS) }, forVin: { type: 'string' }, passed: { type: 'boolean', default: true } } }, example: { classCode: 'PWT' } } } },
        responses: { 201: json('Built.', ref('SubAssembly')), ...ERROR_RESPONSES }
      }
    },
    '/sub-assemblies/buffers': {
      get: {
        tags: ['Sub-Assemblies'], summary: 'Feeder buffer levels',
        description: 'How many of each class are available, and which are close to starving final assembly.',
        responses: { 200: json('Buffer levels.', ref('Collection')) }
      }
    },
    '/sub-assemblies/{serial}': {
      get: {
        tags: ['Sub-Assemblies'], summary: 'Get a sub-assembly',
        parameters: [param('serial', 'path', 'Serial number.')],
        responses: { 200: json('The sub-assembly.', ref('SubAssembly')), 404: ERROR_RESPONSES[404] }
      }
    },

    // ---- Quality ----------------------------------------------------------
    '/quality/summary': {
      get: {
        tags: ['Quality'], summary: 'Quality summary with Pareto, FPY and DPMO',
        parameters: [param('since', 'query', 'Window start.', { type: 'string', format: 'date-time' }), param('lineId', 'query', 'Filter to a line.', { type: 'string', enum: lineIds })],
        responses: { 200: json('Quality summary.', { type: 'object', additionalProperties: true }) }
      }
    },
    '/quality/inspections': {
      get: { tags: ['Quality'], summary: 'List inspections', parameters: [param('stationId', 'query', 'Filter by station.', { type: 'string', enum: stationIds }), param('passed', 'query', 'Only passed or only failed.', { type: 'boolean' }), ...PAGE_PARAMS], responses: { 200: json('Inspections.', ref('Collection')) } },
      post: {
        tags: ['Quality'], summary: 'Record an inspection', security: secured,
        description: 'Evaluates every characteristic against its spec window and raises a defect for each one that is out of tolerance.',
        requestBody: { required: true, content: { 'application/json': { schema: ref('InspectionCreate') } } },
        responses: { 201: json('Inspection recorded, with any defects raised.', { type: 'object', properties: { inspection: ref('Inspection'), defects: { type: 'array', items: ref('Defect') } } }), ...ERROR_RESPONSES }
      }
    },
    '/quality/defects': {
      get: {
        tags: ['Quality'], summary: 'List defects',
        parameters: [
          param('severity', 'query', 'Filter by severity.', { type: 'string', enum: Object.keys(quality.SEVERITIES) }),
          param('status', 'query', 'Filter by status.', { type: 'string', enum: Object.keys(quality.DEFECT_STATES) }),
          param('open', 'query', 'Only open (true) or only closed (false).', { type: 'boolean' }),
          param('vin', 'query', 'Defects on one vehicle.'),
          param('stationId', 'query', 'Defects found at one station.', { type: 'string', enum: stationIds }),
          ...PAGE_PARAMS
        ],
        responses: { 200: json('Defects.', ref('Collection')) }
      },
      post: {
        tags: ['Quality'], summary: 'Raise a defect', security: secured,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code', 'stationId'], properties: { code: { type: 'string', enum: quality.DEFECT_CODES.map((d) => d.code) }, vin: { type: 'string' }, serial: { type: 'string' }, stationId: { type: 'string', enum: stationIds }, severity: { type: 'string', enum: Object.keys(quality.SEVERITIES) }, detectedBy: { type: 'string' } } }, example: { code: 'TORQUE_LOW', vin: exampleVin, stationId: exampleStation, detectedBy: 'qa-202' } } } },
        responses: { 201: json('Defect raised.', ref('Defect')), ...ERROR_RESPONSES }
      }
    },
    '/quality/defects/{id}': { get: { tags: ['Quality'], summary: 'Get a defect', parameters: [param('id', 'path', 'Defect id.')], responses: { 200: json('The defect.', ref('Defect')), 404: ERROR_RESPONSES[404] } } },
    '/quality/defects/{id}/disposition': {
      post: {
        tags: ['Quality'], summary: 'Disposition a defect', security: secured,
        description: 'A CRITICAL defect can never be dispositioned USE_AS_IS. Choosing SCRAP also scraps the vehicle.',
        parameters: [param('id', 'path', 'Defect id.')],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['disposition'], properties: { disposition: { type: 'string', enum: Object.keys(quality.DISPOSITIONS) }, operator: { type: 'string' }, note: { type: 'string' }, repairMinutes: { type: 'number' } } }, example: { disposition: 'REWORK', operator: 'tech-9', repairMinutes: 12 } } } },
        responses: { 200: json('Dispositioned.', ref('Defect')), ...ERROR_RESPONSES }
      }
    },
    '/quality/defects/{id}/close': {
      post: { tags: ['Quality'], summary: 'Close a defect after repair verification', security: secured, parameters: [param('id', 'path', 'Defect id.')], responses: { 200: json('Closed.', ref('Defect')), ...ERROR_RESPONSES } }
    },
    '/quality/gate/{vin}/{stationId}': {
      get: {
        tags: ['Quality'], summary: 'Evaluate a quality gate without moving anything',
        description: 'Pure query. Flows call this before advancing a vehicle so the decision and the movement stay separable.',
        parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin), param('stationId', 'path', 'Gate station.', { type: 'string', enum: stationIds })],
        responses: { 200: json('Gate evaluation with a recommendation.', { type: 'object', additionalProperties: true }), 404: ERROR_RESPONSES[404] }
      }
    },

    // ---- Maintenance ------------------------------------------------------
    '/maintenance': {
      get: {
        tags: ['Station Control'], summary: 'List maintenance orders',
        parameters: [
          param('status', 'query', 'Filter by status.', { type: 'string', enum: Object.keys(controlCore.ORDER_STATES) }),
          param('type', 'query', 'Filter by type.', { type: 'string', enum: Object.keys(controlCore.MAINTENANCE_TYPES) }),
          param('stationId', 'query', 'Filter by station.', { type: 'string', enum: stationIds }),
          ...PAGE_PARAMS
        ],
        responses: { 200: json('Maintenance orders, newest first.', ref('Collection')) }
      }
    },
    '/maintenance/due': {
      get: {
        tags: ['Station Control'], summary: 'Preventive-maintenance status for every station',
        description: 'Cycles run since the last service against an interval derived from the station MTBF. Most overdue first. Overdue stations fail more often in the simulator - skipping PM is not free.',
        parameters: [
          param('lineId', 'query', 'Filter to a line.', { type: 'string', enum: lineIds }),
          param('dueOnly', 'query', 'Only stations DUE_SOON or worse.', { type: 'boolean' })
        ],
        responses: { 200: json('PM status per station.', ref('Collection')) }
      }
    },
    '/maintenance/{id}': {
      get: {
        tags: ['Station Control'], summary: 'Get a maintenance order',
        parameters: [param('id', 'path', 'Maintenance order id.')],
        responses: { 200: json('The order.', ref('MaintenanceOrder')), 404: ERROR_RESPONSES[404] }
      }
    },
    '/reference/state-machines': {
      get: {
        tags: ['Plant'], summary: 'Every entity lifecycle, generated from the enforced transition tables',
        description: 'Work order, vehicle, sub-assembly, defect, andon, station control mode and maintenance order. Built from the same tables the domain enforces, so these cannot drift from the rules. The documentation draws its state diagrams from this.',
        responses: { 200: json('State machines keyed by entity.', { type: 'object', additionalProperties: true }) }
      }
    },
    '/reference/maintenance-types': {
      get: { tags: ['Station Control'], summary: 'Maintenance types, control modes and operator actions', responses: { 200: json('Reference data.', { type: 'object' }) } }
    },

    // ---- Andon -----------------------------------------------------------
    '/andon': {
      get: { tags: ['Andon'], summary: 'List andon calls', parameters: [param('open', 'query', 'Only open calls.', { type: 'boolean' }), param('lineId', 'query', 'Filter by line.', { type: 'string', enum: lineIds }), ...PAGE_PARAMS], responses: { 200: json('Andon calls.', ref('Collection')) } },
      post: {
        tags: ['Andon'], summary: 'Raise an andon call', security: secured,
        description: 'A line-stopping call type also puts the station DOWN and opens a linked downtime record in the same operation.',
        requestBody: { required: true, content: { 'application/json': { schema: ref('AndonCreate') } } },
        responses: { 201: json('Call raised.', ref('Andon')), ...ERROR_RESPONSES }
      }
    },
    '/andon/{id}': { get: { tags: ['Andon'], summary: 'Get an andon call', parameters: [param('id', 'path', 'Andon id.')], responses: { 200: json('The call.', ref('Andon')), 404: ERROR_RESPONSES[404] } } },
    '/andon/{id}/acknowledge': {
      post: { tags: ['Andon'], summary: 'Acknowledge a call', security: secured, description: 'Stops the response-time clock and decides SLA attainment.', parameters: [param('id', 'path', 'Andon id.')], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { responder: { type: 'string' } } }, example: { responder: 'maint-771' } } } }, responses: { 200: json('Acknowledged.', ref('Andon')), ...ERROR_RESPONSES } }
    },
    '/andon/{id}/escalate': { post: { tags: ['Andon'], summary: 'Escalate a call up the ladder', security: secured, parameters: [param('id', 'path', 'Andon id.')], responses: { 200: json('Escalated.', ref('Andon')), ...ERROR_RESPONSES } } },
    '/andon/{id}/resolve': {
      post: { tags: ['Andon'], summary: 'Resolve a call and restart the station', security: secured, parameters: [param('id', 'path', 'Andon id.')], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { resolution: { type: 'string' }, resolver: { type: 'string' } } }, example: { resolution: 'Replaced servo amplifier', resolver: 'maint-771' } } } }, responses: { 200: json('Resolved.', ref('Andon')), ...ERROR_RESPONSES } }
    },

    // ---- Downtime ---------------------------------------------------------
    '/downtime': {
      get: { tags: ['Downtime'], summary: 'List downtime records', parameters: [param('open', 'query', 'Only currently-open stops.', { type: 'boolean' }), param('category', 'query', 'Planned or unplanned.', { type: 'string', enum: ['PLANNED', 'UNPLANNED'] }), param('lineId', 'query', 'Filter by line.', { type: 'string', enum: lineIds }), ...PAGE_PARAMS], responses: { 200: json('Downtime records.', ref('Collection')) } },
      post: { tags: ['Downtime'], summary: 'Open a downtime record', security: secured, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['stationId', 'reasonCode'], properties: { stationId: { type: 'string', enum: stationIds }, reasonCode: { type: 'string', enum: downtimeCore.REASON_CODES.map((r) => r.code) }, note: { type: 'string' }, reportedBy: { type: 'string' } } }, example: { stationId: 'PAINT-40', reasonCode: 'ROBOT_FAULT', reportedBy: 'op-3312' } } } }, responses: { 201: json('Opened.', ref('Downtime')), ...ERROR_RESPONSES } }
    },
    '/downtime/current': { get: { tags: ['Downtime'], summary: 'Stations stopped right now', responses: { 200: json('Open stops, longest first.', ref('Collection')) } } },
    '/downtime/{id}/end': {
      post: { tags: ['Downtime'], summary: 'Close a downtime record', security: secured, parameters: [param('id', 'path', 'Downtime id.')], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { rootCause: { type: 'string' }, correctiveAction: { type: 'string' }, repairedBy: { type: 'string' } } }, example: { rootCause: 'Bell atomizer bearing seizure', correctiveAction: 'Replaced bell cup assembly', repairedBy: 'maint-883' } } } }, responses: { 200: json('Closed.', ref('Downtime')), ...ERROR_RESPONSES } }
    },
    '/operations/summary': { get: { tags: ['Downtime'], summary: 'Andon and downtime performance, with MTBF and MTTR', parameters: [param('since', 'query', 'Window start.', { type: 'string', format: 'date-time' }), param('lineId', 'query', 'Filter to a line.', { type: 'string', enum: lineIds })], responses: { 200: json('Operations summary.', { type: 'object', additionalProperties: true }) } } },

    // ---- KPI --------------------------------------------------------------
    '/kpi/dashboard': {
      get: {
        tags: ['KPI'], summary: 'The whole plant on one screen',
        description: 'Headline OEE and throughput, quality with Pareto, station state mix, open andon calls, current stops, per-line OEE, feeder buffer levels and active work orders.',
        parameters: [param('since', 'query', 'Window start. Defaults to the current shift.', { type: 'string', format: 'date-time' })],
        responses: { 200: json('Dashboard payload.', { type: 'object', additionalProperties: true }) }
      }
    },
    '/kpi/oee': { get: { tags: ['KPI'], summary: 'Plant OEE with per-line breakdown', parameters: [param('since', 'query', 'Window start.', { type: 'string', format: 'date-time' })], responses: { 200: json('Plant OEE.', ref('Oee')) } } },
    '/kpi/calculate': {
      get: {
        tags: ['KPI'], summary: 'Run the ISO 22400 OEE engine on your own numbers',
        description: 'A pure calculation with no plant state - the same engine the plant uses, including the performance cap and the loss waterfall. The OEE calculator in the documentation calls this.',
        parameters: [
          param('plannedBusySeconds', 'query', 'Shift length minus scheduled breaks.', { type: 'number', default: 26400 }),
          param('plannedDowntimeSeconds', 'query', 'Planned stops inside the window.', { type: 'number', default: 0 }),
          param('downtimeSeconds', 'query', 'Unplanned stops inside the window.', { type: 'number', default: 0 }),
          param('totalCount', 'query', 'Units produced.', { type: 'number', default: 0 }),
          param('goodCount', 'query', 'Units that passed first time.', { type: 'number', default: 0 }),
          param('idealCycleSeconds', 'query', 'Rated cycle time.', { type: 'number', default: 60 })
        ],
        responses: { 200: json('OEE with losses and warnings.', ref('Oee')), 400: ERROR_RESPONSES[400] }
      }
    },
    '/kpi/trend': {
      get: {
        tags: ['KPI'], summary: 'Per-shift trend',
        description: 'Reads recomputed detail for recent shifts and stored aggregates for older ones. The current shift is truncated at now and flagged `partial`.',
        parameters: [param('shifts', 'query', 'How many shifts back (1-30).', { type: 'integer', minimum: 1, maximum: 30, default: 8 })],
        responses: { 200: json('Shift trend, oldest first.', ref('Collection')) }
      }
    },

    // ---- Traceability -----------------------------------------------------
    '/trace/recall': {
      post: {
        tags: ['Traceability'], summary: 'Recall analysis for a suspect lot, serial or part',
        description: [
          'The query an MES exists to answer. Given a supplier batch, returns every vehicle containing it,',
          'where each one is now (in plant, in the yard, or shipped), an estimated containment cost, and a',
          'recommended action. Lot lookups are O(1) against a maintained index.'
        ].join('\n\n'),
        security: secured,
        requestBody: { required: true, content: { 'application/json': { schema: ref('RecallQuery') } } },
        responses: { 200: json('Recall report.', ref('RecallReport')), ...ERROR_RESPONSES }
      }
    },
    '/trace/lots': { get: { tags: ['Traceability'], summary: 'Supplier lots the plant has consumed', description: 'Use this to find a lot code to feed into the recall query.', parameters: [param('supplier', 'query', 'Filter by supplier.'), ...PAGE_PARAMS], responses: { 200: json('Lots, most-used first.', ref('Collection')) } } },
    '/trace/lots/{lotCode}': { get: { tags: ['Traceability'], summary: 'Where a lot was consumed', parameters: [param('lotCode', 'path', 'Supplier lot code.')], responses: { 200: json('Lot usage across stations and vehicles.', { type: 'object', additionalProperties: true }) } } },
    '/trace/vehicle/{vin}': { get: { tags: ['Traceability'], summary: 'Complete as-built record for one vehicle', description: 'Genealogy, sub-assemblies with their test results, every inspection and defect, the station route, suppliers and lot codes.', parameters: [param('vin', 'path', 'VIN.', { type: 'string' }, exampleVin)], responses: { 200: json('Vehicle trace.', { type: 'object', additionalProperties: true }), 404: ERROR_RESPONSES[404] } } },

    // ---- Events -----------------------------------------------------------
    '/events': {
      get: {
        tags: ['Events'], summary: 'Query the plant event log',
        parameters: [
          param('type', 'query', 'Exact event type, e.g. unit.moved.'),
          param('severity', 'query', 'Filter by severity.', { type: 'string', enum: ['info', 'success', 'warning', 'error'] }),
          param('lineId', 'query', 'Filter by line.', { type: 'string', enum: lineIds }),
          param('vin', 'query', 'Filter by vehicle.'),
          param('since', 'query', 'Only events after this instant.', { type: 'string', format: 'date-time' }),
          param('limit', 'query', 'Maximum events (default 100, max 1000).', { type: 'integer' })
        ],
        responses: { 200: json('Events, newest first.', { type: 'object', properties: { items: { type: 'array', items: ref('Event') }, total: { type: 'integer' } } }) }
      }
    },
    '/events/stream': {
      get: {
        tags: ['Events'], summary: 'Live event stream (Server-Sent Events)',
        description: [
          'A `text/event-stream` of everything happening on the floor. Plain HTTP, so it works through any',
          'proxy and needs no extra port.',
          '',
          '```js',
          "const stream = new EventSource('/api/v1/events/stream?type=unit,andon');",
          "stream.addEventListener('unit.moved', (e) => console.log(JSON.parse(e.data)));",
          '```',
          '',
          'Swagger UI cannot render a streaming response - use the browser console or `curl -N`.'
        ].join('\n'),
        parameters: [param('type', 'query', 'Comma-separated type prefixes, e.g. `unit,andon`.')],
        responses: { 200: { description: 'An open SSE stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } } }
      }
    },

    // ---- Simulator --------------------------------------------------------
    '/simulator': { get: { tags: ['Simulator'], summary: 'Simulator status', responses: { 200: json('Status.', { type: 'object', additionalProperties: true }) } } },
    '/simulator/{action}': {
      post: {
        tags: ['Simulator'], summary: 'Control the simulated plant', security: secured,
        description: [
          '| Action | Body | Effect |',
          '| --- | --- | --- |',
          '| `start` / `stop` | - | Run or pause production |',
          '| `speed` | `{ "speed": 30 }` | 1 = real time, 30 = a 60 s takt every 2 s |',
          '| `inject-fault` | `{ "stationId": "PAINT-40", "reasonCode": "ROBOT_FAULT", "durationSeconds": 240 }` | Break a station |',
          '| `inject-defect` | `{ "vin": "...", "code": "TORQUE_LOW" }` | Raise a defect on a vehicle |'
        ].join('\n'),
        parameters: [param('action', 'path', 'Control action.', { type: 'string', enum: ['start', 'stop', 'speed', 'inject-fault', 'inject-defect'] })],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true }, example: { speed: 30 } } } },
        responses: { 200: json('Result of the action.', { type: 'object', additionalProperties: true }), ...ERROR_RESPONSES }
      }
    }
  };
}

module.exports = { buildSpec };
