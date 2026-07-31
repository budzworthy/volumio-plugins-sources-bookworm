'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var http = require('http');
var path = require('path');
var spawn = require('child_process').spawn;
var WebSocket = require('ws');

module.exports = ControllerIntercom;

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

function ControllerIntercom(context) {
  var self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;

  // HTTP + WebSocket server handles
  self.httpServer = null;
  self.wsServer = null;

  // aplay child process for raw-PCM playback via Volumio ALSA device
  self.aplayProcess = null;

  // Broadcast lifecycle: idle | starting | live | stopping | error
  self.broadcastState = 'idle';

  // The single WebSocket client that owns the active broadcast
  self.activeWs = null;

  // Volumio playback snapshot taken before we interrupt it
  self.savedVolumioState = null;

  // Plugin configuration (populated in _loadConfig)
  self.serverPort = 8096;
  self.intercomGain = 1.0;
  self.autoResume = true;
  self.sampleRate = 16000;

  // ---------------------------------------------------------------------------
  // Capability flags
  //
  // These flags drive the UI state and serve as documented extension points
  // for a future listen/talkback mode.
  //
  // TODO: [FUTURE-LISTEN] At onStart, probe ALSA capture devices with
  //   `arecord -l` and set supportsListen = true when a capture device is
  //   found.  That flag should gate a "Enable Listen" toggle in UIConfig and
  //   drive a second reverse-channel WebSocket path (plugin → phone).
  //   Keep the capture pipeline in a separate `_startListenPipeline()` helper
  //   so it does not couple to the existing sender path.
  // ---------------------------------------------------------------------------
  self.capabilities = {
    supportsBroadcast: true,  // phone → Volumio speaker (this release)
    supportsListen: false     // Volumio mic → phone  (future two-way mode)
  };
}

// ---------------------------------------------------------------------------
// Volumio lifecycle
// ---------------------------------------------------------------------------

ControllerIntercom.prototype.onVolumioStart = function() {
  var self = this;
  var configFile = self.commandRouter.pluginManager.getConfigurationFile(
    self.context, 'config.json'
  );
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
  return libQ.resolve();
};

ControllerIntercom.prototype.onStart = function() {
  var self = this;
  var defer = libQ.defer();

  self._log('info', 'Starting plugin');
  self._loadConfig();

  self._startServer()
    .then(function() {
      self._log('info', 'Server started on port ' + self.serverPort);
      defer.resolve();
    })
    .fail(function(err) {
      self._log('error', 'Failed to start server: ' + err);
      // Resolve anyway so Volumio startup is not blocked
      defer.resolve();
    });

  return defer.promise;
};

ControllerIntercom.prototype.onStop = function() {
  var self = this;
  var defer = libQ.defer();

  self._log('info', 'Stopping plugin');

  // Kill any active broadcast without trying to restore state — Volumio is
  // shutting down so there is nothing meaningful to restore.
  if (self.broadcastState === 'live' || self.broadcastState === 'starting') {
    self._stopBroadcast(null, false);
  }

  self._stopServer()
    .then(function() {
      defer.resolve();
    })
    .fail(function(err) {
      self._log('error', 'Error stopping server: ' + err);
      defer.resolve();
    });

  return defer.promise;
};

ControllerIntercom.prototype.onRestart = function() {
  // intentionally empty — onStop / onStart cover this
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

ControllerIntercom.prototype.getConfigurationFiles = function() {
  return ['config.json'];
};

ControllerIntercom.prototype._loadConfig = function() {
  var self = this;
  self.serverPort   = parseInt(self.config.get('server_port')   || 8096);
  self.intercomGain = parseFloat(self.config.get('intercom_gain') || 1.0);
  self.autoResume   = self.config.get('auto_resume') !== false;
  self.sampleRate   = parseInt(self.config.get('sample_rate')   || 16000);
};

ControllerIntercom.prototype.getUIConfig = function() {
  var defer = libQ.defer();
  var self = this;
  var lang_code = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  ).then(function(uiconf) {
    var section = uiconf.sections.find(function(s) { return s.id === 'settings'; });
    if (section && section.content) {
      section.content.forEach(function(item) {
        switch (item.id) {
          case 'server_port':
            item.value = self.config.get('server_port') || 8096;
            break;
          case 'intercom_gain':
            item.value = self.config.get('intercom_gain') || 1.0;
            break;
          case 'auto_resume':
            item.value = self.config.get('auto_resume') !== false;
            break;
          case 'sample_rate': {
            var sr = parseInt(self.config.get('sample_rate') || 16000);
            var labels = {
              8000:  '8000 Hz (low bandwidth)',
              16000: '16000 Hz (recommended for voice)',
              44100: '44100 Hz (CD quality)',
              48000: '48000 Hz (studio quality)'
            };
            item.value = { value: sr, label: labels[sr] || (sr + ' Hz') };
            break;
          }
        }
      });
    }
    defer.resolve(uiconf);
  }).fail(function() {
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerIntercom.prototype.setUIConfig = function() {};
ControllerIntercom.prototype.getConf = function() {};
ControllerIntercom.prototype.setConf = function() {};

ControllerIntercom.prototype.saveSettings = function(data) {
  var self = this;

  var port = parseInt(data['server_port']);
  if (!isNaN(port) && port > 1024 && port < 65535) {
    self.config.set('server_port', port);
  }

  var gain = parseFloat(data['intercom_gain']);
  if (!isNaN(gain) && gain >= 0.1 && gain <= 5.0) {
    self.config.set('intercom_gain', gain);
  }

  var resume = data['auto_resume'];
  self.config.set('auto_resume', resume === true || resume === 'true');

  var srRaw = data['sample_rate'];
  var sr = srRaw && srRaw.value ? parseInt(srRaw.value) : parseInt(srRaw);
  if ([8000, 16000, 44100, 48000].indexOf(sr) !== -1) {
    self.config.set('sample_rate', sr);
  }

  var oldPort = self.serverPort;
  self._loadConfig();

  // Restart HTTP/WS server if the port changed and no broadcast is active
  if (self.serverPort !== oldPort && self.broadcastState === 'idle') {
    self._stopServer()
      .then(function() { return self._startServer(); })
      .fail(function(err) {
        self._log('error', 'Server restart failed after port change: ' + err);
      });
  }

  self.commandRouter.pushToastMessage('success', 'Intercom', 'Settings saved');
  return libQ.resolve();
};

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

ControllerIntercom.prototype._startServer = function() {
  var self = this;
  var defer = libQ.defer();

  if (self.httpServer) {
    defer.resolve();
    return defer.promise;
  }

  var uiPath = path.join(__dirname, 'ui', 'index.html');

  self.httpServer = http.createServer(function(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state: self.broadcastState,
        capabilities: self.capabilities,
        sampleRate: self.sampleRate
      }));
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      fs.readFile(uiPath, function(err, data) {
        if (err) {
          res.writeHead(500);
          res.end('UI file not found');
          return;
        }
        // Inject server-side config so the page needs no separate fetch
        var html = data.toString()
          .replace(/\{\{SAMPLE_RATE\}\}/g, String(self.sampleRate));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  self.wsServer = new WebSocket.Server({ server: self.httpServer });

  self.wsServer.on('connection', function(ws, req) {
    var remote = (req.socket && req.socket.remoteAddress) || 'unknown';
    self._log('info', 'WebSocket client connected from ' + remote);
    self._handleWsConnection(ws);
  });

  self.wsServer.on('error', function(err) {
    self._log('error', 'WS server error: ' + err.message);
  });

  self.httpServer.on('error', function(err) {
    self._log('error', 'HTTP server error: ' + err.message);
    if (!self.httpServer._bound) {
      defer.reject(err.message);
    }
  });

  self.httpServer.listen(self.serverPort, '0.0.0.0', function() {
    self.httpServer._bound = true;
    defer.resolve();
  });

  return defer.promise;
};

ControllerIntercom.prototype._stopServer = function() {
  var self = this;
  var defer = libQ.defer();

  if (!self.httpServer) {
    defer.resolve();
    return defer.promise;
  }

  // Close all connected WebSocket clients
  if (self.wsServer) {
    self.wsServer.clients.forEach(function(client) {
      try { client.terminate(); } catch (e) {}
    });
    try { self.wsServer.close(); } catch (e) {}
    self.wsServer = null;
  }

  self.httpServer.close(function() {
    self.httpServer = null;
    defer.resolve();
  });

  return defer.promise;
};

// ---------------------------------------------------------------------------
// WebSocket message handling
// ---------------------------------------------------------------------------

ControllerIntercom.prototype._handleWsConnection = function(ws) {
  var self = this;

  ws.on('message', function(data, isBinary) {
    if (!isBinary) {
      // Text frame — JSON control message
      var msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }

      if (msg.type === 'start') {
        self._startBroadcast(ws);
      } else if (msg.type === 'stop') {
        if (self.activeWs === ws) {
          self._stopBroadcast(ws, true);
        }
      }
    } else {
      // Binary frame — raw PCM audio (Int16 LE, mono, sampleRate Hz)
      if (self.broadcastState === 'live' && self.activeWs === ws) {
        var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        self._writeAudio(buf);
      }
    }
  });

  ws.on('close', function() {
    self._log('info', 'WebSocket client disconnected');
    if (self.activeWs === ws &&
        (self.broadcastState === 'live' || self.broadcastState === 'starting')) {
      self._log('info', 'Active broadcast client disconnected — stopping broadcast');
      self._stopBroadcast(null, true);
    }
    if (self.activeWs === ws) {
      self.activeWs = null;
    }
  });

  ws.on('error', function(err) {
    self._log('error', 'WebSocket error: ' + err.message);
    if (self.activeWs === ws &&
        (self.broadcastState === 'live' || self.broadcastState === 'starting')) {
      self._stopBroadcast(null, true);
    }
  });
};

// Apply server-side gain to a Buffer of Int16 LE PCM samples
ControllerIntercom.prototype._writeAudio = function(buf) {
  var self = this;
  if (!self.aplayProcess || !self.aplayProcess.stdin.writable) return;

  var gain = self.intercomGain;
  if (Math.abs(gain - 1.0) < 0.005) {
    // Unity gain — write directly without copying
    try { self.aplayProcess.stdin.write(buf); } catch (e) {}
    return;
  }

  var out = Buffer.alloc(buf.length);
  for (var i = 0; i + 1 < buf.length; i += 2) {
    var s = buf.readInt16LE(i);
    s = Math.round(s * gain);
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    out.writeInt16LE(s, i);
  }
  try { self.aplayProcess.stdin.write(out); } catch (e) {}
};

// ---------------------------------------------------------------------------
// Broadcast lifecycle
// ---------------------------------------------------------------------------

ControllerIntercom.prototype._startBroadcast = function(ws) {
  var self = this;

  if (self.broadcastState !== 'idle') {
    self._log('warn', 'Start requested but state is ' + self.broadcastState);
    self._sendStatus(ws, 'busy',
      'Another broadcast is already active. Wait for it to finish.');
    return;
  }

  self._log('info', 'Starting broadcast');
  self.broadcastState = 'starting';
  self.activeWs = ws;

  // ---- Save current Volumio playback state --------------------------------
  try {
    var vState = self.commandRouter.stateMachine.getState();
    self.savedVolumioState = {
      status:  vState.status  || 'stop',
      service: vState.service || '',
      uri:     vState.uri     || '',
      seek:    vState.seek    || 0,
      volume:  vState.volume
    };
    self._log('info',
      'Saved Volumio state: status=' + self.savedVolumioState.status +
      ' service=' + (self.savedVolumioState.service || 'none'));
  } catch (e) {
    self._log('warn', 'Could not save Volumio state: ' + e.message);
    self.savedVolumioState = null;
  }

  // ---- Stop current Volumio playback so ALSA device is free ---------------
  try {
    self.commandRouter.volumioStop();
    self._log('info', 'Stopped Volumio playback');
  } catch (e) {
    self._log('warn', 'Could not stop Volumio: ' + e.message);
  }

  // Give MPD / ALSA 500 ms to release the device before aplay opens it
  setTimeout(function() {
    self._spawnAplay()
      .then(function() {
        self.broadcastState = 'live';
        self._log('info', 'Broadcast is live');
        self._sendStatus(ws, 'live', 'Broadcast is live');
      })
      .fail(function(err) {
        self._log('error', 'Failed to start aplay: ' + err);
        self.broadcastState = 'error';
        self._sendStatus(ws, 'error', 'Failed to open audio output: ' + err);
        self._restoreState();
        self.broadcastState = 'idle';
        self.activeWs = null;
      });
  }, 500);
};

ControllerIntercom.prototype._stopBroadcast = function(ws, doRestore) {
  var self = this;

  if (self.broadcastState !== 'live' && self.broadcastState !== 'starting') {
    return;
  }

  self._log('info', 'Stopping broadcast');
  self.broadcastState = 'stopping';

  self._killAplay();

  // Acknowledge stop to the requesting client (may be null on disconnect)
  if (ws && ws.readyState === WebSocket.OPEN) {
    self._sendStatus(ws, 'idle', 'Broadcast stopped');
  }

  if (doRestore && self.autoResume) {
    // Small delay so aplay fully releases the ALSA device before MPD resumes
    setTimeout(function() {
      self._restoreState();
    }, 300);
  } else {
    self.savedVolumioState = null;
  }

  self.broadcastState = 'idle';
  self.activeWs = null;
  self._log('info', 'Broadcast stopped');
};

// ---------------------------------------------------------------------------
// aplay process management
// ---------------------------------------------------------------------------

ControllerIntercom.prototype._spawnAplay = function() {
  var self = this;
  var defer = libQ.defer();

  var args = [
    '-f', 'S16_LE',
    '-r', String(self.sampleRate),
    '-c', '1',
    '-D', 'volumio'
  ];

  self._log('info', 'Spawning: aplay ' + args.join(' '));

  var proc;
  try {
    proc = spawn('aplay', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (e) {
    defer.reject('spawn failed: ' + e.message);
    return defer.promise;
  }

  self.aplayProcess = proc;

  // Resolve after a short grace period — aplay writes to stderr only when
  // it starts playing, and we don't want to wait forever for the first chunk.
  var resolved = false;
  var grace = setTimeout(function() {
    if (!resolved) { resolved = true; defer.resolve(); }
  }, 600);

  proc.stderr.on('data', function(chunk) {
    var line = chunk.toString().trim();
    if (line) self._log('info', 'aplay: ' + line);
    // "Playing raw data" appears when aplay is ready
    if (!resolved && /playing/i.test(line)) {
      resolved = true;
      clearTimeout(grace);
      defer.resolve();
    }
  });

  proc.on('error', function(err) {
    self._log('error', 'aplay process error: ' + err.message);
    self.aplayProcess = null;
    clearTimeout(grace);
    if (!resolved) { resolved = true; defer.reject(err.message); }
  });

  proc.stdin.on('error', function(err) {
    // EPIPE is expected when we close stdin; others are worth logging
    if (err.code !== 'EPIPE') {
      self._log('error', 'aplay stdin error: ' + err.message);
    }
  });

  proc.on('exit', function(code, signal) {
    self._log('info', 'aplay exited code=' + code + ' signal=' + signal);
    self.aplayProcess = null;
    // Unexpected exit during an active broadcast
    if (self.broadcastState === 'live') {
      self._log('warn', 'aplay exited unexpectedly — ending broadcast');
      var client = self.activeWs;
      self.broadcastState = 'idle';
      self.activeWs = null;
      if (client && client.readyState === WebSocket.OPEN) {
        self._sendStatus(client, 'error', 'Audio output ended unexpectedly');
      }
      if (self.autoResume) self._restoreState();
      else self.savedVolumioState = null;
    }
  });

  return defer.promise;
};

ControllerIntercom.prototype._killAplay = function() {
  var self = this;
  if (!self.aplayProcess) return;

  self._log('info', 'Terminating aplay');
  try { self.aplayProcess.stdin.end(); } catch (e) {}
  try { self.aplayProcess.kill('SIGTERM'); } catch (e) {}

  // Force-kill after 2 s if it hasn't exited
  var proc = self.aplayProcess;
  setTimeout(function() {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }, 2000);

  self.aplayProcess = null;
};

// ---------------------------------------------------------------------------
// Volumio state restore
// ---------------------------------------------------------------------------

ControllerIntercom.prototype._restoreState = function() {
  var self = this;
  var snap = self.savedVolumioState;
  self.savedVolumioState = null;

  if (!snap) return;

  if (snap.status === 'play') {
    self._log('info',
      'Restoring playback (was playing, service=' + (snap.service || 'unknown') + ')');
    try {
      // volumioPlay() resumes the existing MPD queue / service state.
      // For non-MPD services (Spotify, YouTube, etc.) this is best-effort:
      // the queue item should still be present so Volumio can replay it.
      self.commandRouter.volumioPlay();
    } catch (e) {
      self._log('warn', 'Could not restore playback: ' + e.message);
    }
  } else {
    self._log('info', 'Playback was not active before broadcast — nothing to restore');
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

ControllerIntercom.prototype._sendStatus = function(ws, state, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: 'status', state: state, message: message || '' }));
  } catch (e) {}
};

ControllerIntercom.prototype._log = function(level, msg) {
  var self = this;
  var prefix = '[Intercom] ';
  if (level === 'error') {
    self.logger.error(prefix + msg);
  } else if (level === 'warn') {
    self.logger.warn(prefix + msg);
  } else {
    self.logger.info(prefix + msg);
  }
};
