'use strict';

/**
 * Node-RED runtime settings.
 *
 * Node-RED is embedded rather than run standalone, so these settings are built
 * in code instead of copied from the default settings.js template. That keeps
 * one source of configuration for the whole application and lets the editor,
 * the API and the HMI share a port.
 */

const path = require('path');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('node-red');

/**
 * @param {object} ctx application context, exposed to flows as global context
 * @returns {object} Node-RED settings object
 */
function buildSettings(ctx) {
  const settings = {
    // ---- paths ------------------------------------------------------------
    userDir: config.nodeRed.userDir,
    flowFile: config.nodeRed.flowFile,
    // Custom nodes live in the repo, not in userDir/node_modules, so they are
    // versioned with the flows that use them.
    nodesDir: config.nodeRed.nodesDir,
    coreNodesDir: path.dirname(require.resolve('@node-red/nodes/package.json')),

    // ---- http -------------------------------------------------------------
    httpAdminRoot: config.nodeRed.httpAdminRoot,
    httpNodeRoot: config.nodeRed.httpNodeRoot,
    uiPort: config.http.port,

    // ---- runtime ----------------------------------------------------------
    // Credentials never leave this instance, so the key only has to be stable
    // across restarts of the same deployment.
    credentialSecret: process.env.PC_CREDENTIAL_SECRET
      || 'production-core-credential-secret',
    // Flows are generated from flows/plant.spec.js and are read-only in
    // production. A visitor can open and inspect them; only a local developer
    // regenerates them with `npm run build:flows`.
    readOnly: config.security.editorReadOnly,
    flowFilePretty: true,
    disableEditor: false,

    // Node-RED 4 offers to phone home for version checks and prompts every
    // visitor about it. Declining explicitly suppresses the dialog, and a
    // public demo has no business reporting anything anywhere.
    telemetry: { enabled: false },

    logging: {
      console: {
        level: config.logging.level === 'debug' ? 'debug'
          : config.logging.level === 'silent' ? 'off' : 'info',
        metrics: false,
        audit: false
      }
    },

    // ---- function nodes ---------------------------------------------------
    functionGlobalContext: {
      // Flows can reach the domain model directly, which is what makes a
      // function node in a flow able to answer "what is the next station" the
      // same way the API does.
      plantModel: require('../core/plantModel'),
      productionCore: ctx,
      os: require('os')
    },
    // Modules a function node may require, per Node-RED 4's allow-list.
    functionExternalModules: false,

    // ---- editor -----------------------------------------------------------
    editorTheme: {
      page: {
        title: 'Production Core - Windsor Assembly Plant',
        favicon: path.join(config.rootDir, 'public', 'favicon.ico')
      },
      header: {
        title: 'Production Core - Vehicle Assembly MES',
        url: '/'
      },
      palette: {
        // Keep the palette manager off in a public demo: it writes to disk and
        // can install arbitrary packages.
        editable: !config.isProduction
      },
      projects: { enabled: false },
      tours: false,
      menu: {
        'menu-item-import-library': false,
        'menu-item-export-library': false
      },
      userMenu: false,
      login: { image: undefined }
    },

    // ---- context storage --------------------------------------------------
    contextStorage: {
      // Flow/global context is in-memory only; the repository is the system of
      // record, and duplicating state into a second store invites drift.
      default: { module: 'memory' }
    },

    // ---- lifecycle hooks --------------------------------------------------
    /** Called once the runtime has started. */
    runtimeState: { enabled: false, ui: false }
  };

  // ---- optional editor authentication -------------------------------------
  if (config.security.editorUser && config.security.editorPassword) {
    // bcrypt arrives with Node-RED; hashing here avoids storing a plaintext
    // password in the settings object.
    let hashed;
    try {
      const bcrypt = require('bcryptjs');
      hashed = bcrypt.hashSync(config.security.editorPassword, 8);
    } catch (_error) {
      log.warn('bcryptjs unavailable; editor authentication is disabled');
    }

    if (hashed) {
      settings.adminAuth = {
        type: 'credentials',
        users: [{
          username: config.security.editorUser,
          password: hashed,
          permissions: config.security.editorReadOnly ? 'read' : '*'
        }],
        // Anyone who has not logged in can still read the flows, which is the
        // point of a portfolio demo.
        default: { permissions: 'read' }
      };
      log.info('node-red editor authentication enabled', {
        user: config.security.editorUser,
        readOnly: config.security.editorReadOnly
      });
    }
  } else if (config.security.editorReadOnly) {
    settings.adminAuth = {
      type: 'credentials',
      users: [],
      default: { permissions: 'read' }
    };
    log.info('node-red editor is read-only for all visitors');
  }

  return settings;
}

module.exports = { buildSettings };
