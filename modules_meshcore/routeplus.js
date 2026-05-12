/** 
* @description MeshCentral RoutePlus plugin
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";
var mesh;
var obj = this;
var _sessionid;
var isWsconnection = false;
var wscon = null;
var db = require('SimpleDataStore').Shared();
var routeTrack = {};
var debug_flag = false;
var routeProbeTimeoutMs = 5000;
var routeProbeCooldownMs = 5000;
var routeRestartDelayMs = 750;
var tunnelSetupTimeoutMs = 5000;
var maxPendingTunnelBytes = 1024 * 1024;
var lastStartRouteCall = {};
var waitTimer = {};

var fs = require('fs');
var os = require('os');
var net = require('net');
var http = require('http');

var dbg = function(str) {
    if (debug_flag !== true) return;
    var fs = require('fs');
    var logStream = fs.createWriteStream('routeplus.txt', {'flags': 'a'});
    // use {'flags': 'a'} to append and {'flags': 'w'} to erase and write a new file
    logStream.write('\n'+new Date().toLocaleString()+': '+ str);
    logStream.end('\n');
}

function safeErrorString(e) {
    if (e == null) return 'Unknown error';
    if (typeof e === 'string') return e;
    var parts = [];
    if (e.code != null) parts.push(e.code);
    if (e.message != null) parts.push(e.message);
    if (parts.length > 0) return parts.join(': ');
    try { return JSON.stringify(e); } catch (ex) { }
    return '' + e;
}

function sendPluginCommand(action, data) {
    var msg = {
        action: 'plugin',
        plugin: 'routeplus',
        pluginaction: action,
        sessionid: _sessionid,
        tag: 'console'
    };
    if (data != null) {
        Object.keys(data).forEach(function(k) { msg[k] = data[k]; });
    }
    mesh.SendCommand(msg);
}

function reportRouteError(mid, reason, err, localport) {
    var errorText = safeErrorString(err);
    dbg('Route error [' + reason + '] for ' + mid + ': ' + errorText);
    try {
        sendPluginCommand('routeError', {
            mid: mid,
            reason: reason,
            error: errorText,
            localport: localport
        });
    } catch (ex) {
        dbg('Unable to report route error for ' + mid + ': ' + safeErrorString(ex));
    }
}

function configureTunnelSocket(socket) {
    if (socket == null) return;
    try {
        if (typeof socket.setKeepAlive === 'function') { socket.setKeepAlive(true, 30000); }
    } catch (ex) { }
    try {
        if (typeof socket.setNoDelay === 'function') { socket.setNoDelay(true); }
    } catch (ex) { }
}

function dataLength(data) {
    if (data == null) return 0;
    if (typeof data.length === 'number') return data.length;
    if (typeof data.byteLength === 'number') return data.byteLength;
    try { return data.toString().length; } catch (ex) { }
    return 0;
}

function clearTunnelSetupTimer(tcp) {
    if (tcp == null || tcp.routeplusSetupTimer == null) return;
    try { clearTimeout(tcp.routeplusSetupTimer); } catch (ex) { }
    tcp.routeplusSetupTimer = null;
}

function cloneRouteSettings(settings) {
    var copy = {};
    Object.keys(settings || {}).forEach(function(k) { copy[k] = settings[k]; });
    return copy;
}

function resetRouteHealthState(route) {
    if (route == null) return;
    route.consecutiveFailures = 0;
    route.healthProbeInFlight = false;
    route.restartRequested = false;
    route.restartScheduled = false;
    route.restartReason = null;
    route.restartForced = false;
}

function buildRouteRelayOptions(settings) {
    if (settings.authCookie == null) {
        throw new Error('Route has no MeshCentral auth cookie');
    }

    return http.parseUri(settings.serverurl + '?noping=1&auth=' + encodeURIComponent(settings.authCookie) + '&nodeid=' + encodeURIComponent(settings.remotenodeid) + '&tcpport=' + encodeURIComponent(settings.remoteport) + (settings.remotetarget == null ? '' : '&tcpaddr=' + encodeURIComponent(settings.remotetarget)));
}

function maybeRestartRoute(route) {
    if (route == null || route.restartRequested !== true || route.restartScheduled === true) return;
    if (route.activeClients > 0 && route.restartForced !== true) return;

    route.restartScheduled = true;
    var mapid = route.settings.mapid;
    var oldOnListen = route.onListen;
    var reason = route.restartReason || 'unknown';
    dbg('Restarting route ' + mapid + ' after ' + reason);
    if (route.restartForced === true) {
        destroyRouteClients(route, 'Forced route restart: ' + reason);
    }

    setTimeout(function() {
        if (routeTrack[mapid] !== route) return;
        var oldSettings = cloneRouteSettings(route.settings);

        try {
            route.tcpserver.close(function() {
                if (routeTrack[oldSettings.mapid] !== route) return;
                delete routeTrack[oldSettings.mapid];

                try {
                    var replacement = new RoutePlusRoute();
                    replacement.onListen = oldOnListen;
                    replacement.startRouter(oldSettings);
                    routeTrack[oldSettings.mapid] = replacement;
                    dbg('Route ' + oldSettings.mapid + ' restarted.');
                } catch (e) {
                    reportRouteError(oldSettings.mapid, 'restartListenError', e, oldSettings.localport);
                }
            });
        } catch (e) {
            route.restartScheduled = false;
            reportRouteError(mapid, 'restartCloseError', e, oldSettings.localport);
        }
    }, routeRestartDelayMs);
}

function requestRouteRestart(route, reason, force) {
    if (route == null) return;
    if (route.restartRequested === true) {
        if (force === true && route.restartForced !== true) {
            route.restartForced = true;
            route.restartReason = reason;
            maybeRestartRoute(route);
        }
        return;
    }
    route.restartRequested = true;
    route.restartReason = reason;
    route.restartForced = force === true;
    dbg('Route ' + route.settings.mapid + ' queued for restart: ' + reason);
    maybeRestartRoute(route);
}

function trackRouteClient(route, socket) {
    if (route == null || socket == null) return;
    if (route.clientSockets == null) route.clientSockets = [];
    route.clientSockets.push(socket);
}

function untrackRouteClient(route, socket) {
    if (route == null || route.clientSockets == null || socket == null) return;
    var index = route.clientSockets.indexOf(socket);
    if (index >= 0) route.clientSockets.remove(index);
}

function destroyRouteClients(route, reason) {
    if (route == null || route.clientSockets == null) return;
    var sockets = route.clientSockets.slice(0);
    route.clientSockets = [];
    for (var i = 0; i < sockets.length; i++) {
        try { disconnectTunnel(sockets[i], sockets[i].websocket, reason); } catch (e) { debug(2, e); }
        try { sockets[i].destroy(); } catch (e) { debug(2, e); }
    }
}

function noteTunnelClosed(route, wasActive, reason) {
    if (route == null) return;
    route.activeClients = Math.max(0, route.activeClients - 1);

    if (wasActive === true) {
        route.consecutiveFailures = 0;
    } else {
        route.consecutiveFailures++;
        if (route.consecutiveFailures >= 2) {
            requestRouteRestart(route, 'repeated pre-active tunnel failures: ' + reason, true);
            return;
        }
        scheduleRouteHealthProbe(route, reason);
    }

    maybeRestartRoute(route);
}

function finishRouteHealthProbe(probe, isReachable, reason) {
    if (probe == null || probe.finished === true) return;
    probe.finished = true;
    try { clearTimeout(probe.timeout); } catch (e) { }
    try { if (probe.socket != null) { probe.socket.end(); } } catch (e) { }
    try { if (probe.socket != null) { probe.socket.destroy(); } } catch (e) { }
    try { if (probe.request != null) { probe.request.end(); } } catch (e) { }
    try { if (probe.request != null) { probe.request.destroy(); } } catch (e) { }

    if (routeTrack[probe.settings.mapid] !== probe.route) return;

    probe.route.healthProbeInFlight = false;
    if (isReachable === true) {
        probe.route.consecutiveFailures = 0;
        dbg('Route ' + probe.settings.mapid + ' health probe reached target port.');
        return;
    }

    requestRouteRestart(probe.route, 'target port probe failed after tunnel failure: ' + reason);
}

function scheduleRouteHealthProbe(route, reason) {
    if (route == null || route.restartRequested === true || route.healthProbeInFlight === true) return;
    var now = Date.now();
    if (route.lastHealthProbeStartedAt != null && now - route.lastHealthProbeStartedAt < routeProbeCooldownMs) {
        return;
    }

    route.healthProbeInFlight = true;
    route.lastHealthProbeStartedAt = now;
    var settings = cloneRouteSettings(route.settings);
    var probe = {
        route: route,
        settings: settings,
        reason: reason,
        finished: false,
        request: null,
        socket: null,
        timeout: null
    };

    dbg('Route ' + settings.mapid + ' health probe starting after: ' + reason);
    probe.timeout = setTimeout(function() {
        finishRouteHealthProbe(probe, false, 'probe timeout');
    }, routeProbeTimeoutMs);

    try {
        var options = buildRouteRelayOptions(settings);
        options.rejectUnauthorized = false;
        options.agent = false;
        probe.request = http.request(options);
        probe.request.routeHealthProbe = probe;
        probe.request.upgrade = OnRouteHealthProbeWebSocket;
        probe.request.on('error', function(e) {
            finishRouteHealthProbe(this.routeHealthProbe, false, 'probe request error: ' + safeErrorString(e));
        });
        probe.request.on('response', function(res) {
            try { res.resume(); } catch (e) { }
            finishRouteHealthProbe(this.routeHealthProbe, false, 'probe HTTP response: ' + res.statusCode);
        });
        probe.request.end();
    } catch (e) {
        finishRouteHealthProbe(probe, false, safeErrorString(e));
    }
}

Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

function consoleaction(args, rights, sessionid, parent) {
    isWsconnection = false;
    wscon = parent;
    _sessionid = sessionid;
    if (typeof args['_'] == 'undefined') {
      args['_'] = [];
      args['_'][1] = args.pluginaction;
      args['_'][2] = null;
      args['_'][3] = null;
      args['_'][4] = null;
      isWsconnection = true;
    }
    
    var fnname = args['_'][1];
    mesh = parent;
    
    switch (fnname) {
        case 'startRoute':
            var nowTime = Math.floor(new Date() / 1000);
            // check for multiple calls. The agentCoreIsStable hook calls in rapid succession when re-checking in
            // This will avoid "stomping" on the setup process
            if (lastStartRouteCall[args.mid] >= nowTime - 3 && args.waitTimer != 'y') {
                dbg('Ignoring startRoute (called within the last 3 seconds)');
                return;
            }
            lastStartRouteCall[args.mid] = nowTime;
            // hold the unique mapId in memory in case a new packet is sent for recreation
            if (routeTrack[args.mid] != null && routeTrack[args.mid] != 'undefined') {
                try {
                    if (args.localport == routeTrack[args.mid].tcpserver.address().port && routeTrack[args.mid].settings.remotenodeid == args.nodeid) {
                        routeTrack[args.mid].settings.authCookie = args.rauth;
                        routeTrack[args.mid].settings.remoteport = args.remoteport;
                        routeTrack[args.mid].settings.remotetarget = args.remotetarget;
                        if ((typeof args.relayurl == 'string') && (args.relayurl.length > 0)) {
                            routeTrack[args.mid].settings.serverurl = args.relayurl;
                        }
                        resetRouteHealthState(routeTrack[args.mid]);
                        dbg('Start / rebuild command sent when route is already listening. Refreshed auth and target settings.');
                        return;
                    }
                } catch (e) { }
                dbg('destroying connection to rebuild: ' + args.mid);
                routeTrack[args.mid].tcpserver.close();
                delete routeTrack[args.mid];
                dbg('wait timer set');
                args.waitTimer = 'y';
                waitTimer[args.mid] = setInterval(function() { consoleaction(args, rights, sessionid, parent); }, 1000);
                return;
            } else {
                dbg('No existing route found, continuing');
            }
            if (waitTimer[args.mid] != null) {
                clearInterval(waitTimer[args.mid]);
                delete waitTimer[args.mid];
            }
            dbg('Starting Route');
            //dbg('Got: ' + JSON.stringify(args));
            var r = new RoutePlusRoute();
            var settings = {
                mapid: args.mid,
                serverurl: ((typeof args.relayurl == 'string') && (args.relayurl.length > 0)) ? args.relayurl : mesh.ServerUrl.replace('agent.ashx', 'meshrelay.ashx'),
                authCookie: args.rauth,
                remotenodeid: args.nodeid,
                remotetarget: args.remotetarget,
                remoteport: args.remoteport,
                localport: args.localport == null ? 0 : args.localport,
                forceSrcPort: args.forceSrcPort
            };
            try {
                r.onListen = function(actualLocalPort) {
                    dbg('Listening on ' + actualLocalPort);
                    if (args.localport != actualLocalPort) {
                        dbg('Sending updated port ' + actualLocalPort);
                        sendPluginCommand('updateMapPort', {
                            mid: args.mid,
                            port: actualLocalPort
                        });
                    }
                };
                r.startRouter(settings);
                routeTrack[args.mid] = r;
            } catch (e) {
                if (args.forceSrcPort == true) {
                    dbg('Source port is forced, but unavailable. Not mapping. (port: ' + args.localport + ')');
                    sendPluginCommand('cantMapPort', {
                        mid: args.mid,
                        error: safeErrorString(e),
                        localport: args.localport
                    });
                } else {
                    reportRouteError(args.mid, 'listenError', e, args.localport);
                }
                return;
            }
        break;
        case 'endRoute':
            dbg('Attempting to end route for ' + args.mid);
            if (routeTrack[args.mid] != null && routeTrack[args.mid] != 'undefined') {
                dbg('Ending route for ' + args.mid);
                routeTrack[args.mid].tcpserver.close();
                delete routeTrack[args.mid];
            }
        break;
        case 'updateCookie':
            Object.keys(routeTrack).forEach(function(k) {
                if (routeTrack[k] != null && routeTrack[k].settings != null) {
                    routeTrack[k].settings.authCookie = args.rauth;
                }
            });
        break;
        case 'list':
            var s = '', count = 1;
            Object.keys(routeTrack).forEach(function (k) {
              s += count + ': Port ' + routeTrack[k].tcpserver.address().port + ' (Map ID: ' + k + ')\n';
              count++;
            });
            if (s == '') s = 'No active port mappings';
            return s;
        break;
        default:
            dbg('Unknown action: '+ fnname + ' with data ' + JSON.stringify(args));
        break;
    }
}

function RoutePlusRoute() {
    var rObj = {};
    
    rObj.settings = null;
    
    rObj.tcpserver = null;
    rObj.onListen = null;
    rObj.clientSockets = [];
    rObj.activeClients = 0;
    rObj.consecutiveFailures = 0;
    rObj.healthProbeInFlight = false;
    rObj.lastHealthProbeStartedAt = null;
    rObj.restartRequested = false;
    rObj.restartScheduled = false;
    rObj.restartReason = null;
    rObj.startRouter = startRouter;
    rObj.debug = debug;
    rObj.OnTcpClientConnected = function (c) {
        try {
            rObj.activeClients++;
            c.routeplusRoute = rObj;
            c.routeplusClosed = false;
            trackRouteClient(rObj, c);
            /*if (rObj.settings.isMagic === true && rObj.settings.magicNode != null) {
                mesh.SendCommand({ 
                    "action": "plugin", 
                    "plugin": "routeplus",
                    "pluginaction": "magicConnect",
                    "sessionid": _sessionid,
                    "tag": "console"
                });
                return;
            }*/
            // 'connection' listener
            configureTunnelSocket(c);
            c.routeplusTunnelActive = false;
            c.routeplusPendingData = [];
            c.routeplusPendingBytes = 0;
            c.routeplusSetupTimer = setTimeout(function() {
                if (c.routeplusClosed === true) return;
                if (c.websocket != null && c.websocket.tunneling === true) return;
                reportRouteError(rObj.settings.mapid, 'tunnelSetupTimeout', 'Tunnel did not become active within ' + tunnelSetupTimeoutMs + ' ms', rObj.settings.localport);
                disconnectTunnel(c, c.websocket, 'Tunnel setup timeout');
                requestRouteRestart(rObj, 'tunnel setup timeout', true);
            }, tunnelSetupTimeoutMs);
            c.on('data', function (data) {
                if (this.routeplusTunnelActive === true) return;
                this.routeplusPendingBytes += dataLength(data);
                this.routeplusPendingData.push(data);
                if (this.routeplusPendingBytes > maxPendingTunnelBytes) {
                    reportRouteError(rObj.settings.mapid, 'pendingTunnelBufferExceeded', 'Pending tunnel data exceeded ' + maxPendingTunnelBytes + ' bytes', rObj.settings.localport);
                    disconnectTunnel(this, this.websocket, 'Pending tunnel buffer exceeded');
                }
            });
            c.on('end', function () { disconnectTunnel(this, this.websocket, "Client closed"); });
            c.on('close', function () { untrackRouteClient(rObj, this); disconnectTunnel(this, this.websocket, "Client socket closed"); });
            c.on('error', function (e) { disconnectTunnel(this, this.websocket, "Client socket error: " + safeErrorString(e)); });
            try {
                if (rObj.settings.authCookie == null) {
                    reportRouteError(rObj.settings.mapid, 'missingAuthCookie', 'Route has no MeshCentral auth cookie', rObj.settings.localport);
                    disconnectTunnel(c, null, "Missing MeshCentral auth cookie");
                    return;
                }

                var options = buildRouteRelayOptions(rObj.settings);
            } catch (e) {
                dbg("Unable to parse \"serverUrl\"." + e);
                reportRouteError(rObj.settings.mapid, 'parseServerUrl', e, rObj.settings.localport);
                disconnectTunnel(c, null, "Unable to parse server URL");
                return;
            }
            options.checkServerIdentity = this.onVerifyServer;
            options.rejectUnauthorized = false;
            options.agent = false;
            c.websocket = http.request(options);
            c.websocket.tcp = c;
            c.websocket.route = c.routeplusRoute;
            c.websocket.tunneling = false;
            c.websocket.routeplusClosed = false;
            c.websocket.upgrade = OnWebSocket;
            c.websocket.on('error', function (e) {
                dbg("ERROR: " + safeErrorString(e));
                reportRouteError(rObj.settings.mapid, 'websocketRequestError', e, rObj.settings.localport);
                disconnectTunnel(this.tcp, this, "Websocket request error");
            });
            c.websocket.on('response', function (res) {
                try { res.resume(); } catch (e) { }
                reportRouteError(rObj.settings.mapid, 'websocketHttpResponse', 'HTTP ' + res.statusCode, rObj.settings.localport);
                disconnectTunnel(this.tcp, this, 'Websocket HTTP response: ' + res.statusCode);
            });
            c.websocket.end();
        } catch (e) {
            disconnectTunnel(c, c.websocket, 'Connection setup exception');
            reportRouteError(rObj.settings.mapid, 'connectionSetupError', e, rObj.settings.localport);
            debug(2, 'catch block 2' + e);
        }
    };
    rObj.disconnectTunnel = disconnectTunnel;
    rObj.OnWebSocket = OnWebSocket;
    
    return rObj;
}

function startRouter(settings) {
    this.settings = settings;
    this.tcpserver = net.createServer(this.OnTcpClientConnected);
    var t = this;
    this.tcpserver.on('error', function (e) {
        dbg("ERROR: " + JSON.stringify(e));
        if (routeTrack[t.settings.mapid] === t) {
            delete routeTrack[t.settings.mapid];
        }
        try { t.tcpserver.close(); } catch (ex) { }
        if (t.settings.forceSrcPort === true) {
            dbg('Source port is forced, but unavailable. Not mapping. (port: ' + t.settings.localport + ')');
            try {
                sendPluginCommand('cantMapPort', {
                    mid: t.settings.mapid,
                    error: safeErrorString(e),
                    localport: t.settings.localport
                });
            } catch (ex) {
                dbg('Unable to report cantMapPort for ' + t.settings.mapid + ': ' + safeErrorString(ex));
            }
            return;
        }
        reportRouteError(t.settings.mapid, 'listenError', e, t.settings.localport);
    });
    this.tcpserver.listen(this.settings.localport, function () {
        // We started listening.
        if (t.settings.remotetarget == null) {
            dbg('Redirecting local port ' + t.lport + ' to remote port ' + t.settings.remoteport + '.');
        } else {
            dbg('Redirecting local port ' + t.lport + ' to ' + t.settings.remotetarget + ':' + t.settings.remoteport + '.');
        }
        if (typeof t.onListen === 'function') {
            t.onListen(t.tcpserver.address().port);
        }
        //console.log("Press ctrl-c to exit.");

        // If settings has a "cmd", run it now.
        //process.exec("notepad.exe");
    });
}

// Called when a TCP connect is received on the local port. Launch a tunnel.

function debug(level, message) { { dbg(message); } }

// Disconnect both TCP & WebSocket connections and display a message.
function disconnectTunnel(tcp, ws, msg) {
    var route = null;
    var wasActive = false;
    var alreadyClosed = false;
    if (ws != null) {
        route = ws.route || ((ws.parent != null) ? ws.parent.route : null);
        wasActive = (ws.tunneling === true) || ((ws.parent != null) && (ws.parent.tunneling === true));
        if (ws.routeplusClosed === true || ((ws.parent != null) && (ws.parent.routeplusClosed === true))) {
            alreadyClosed = true;
        }
    }
    if (tcp != null) {
        if (route == null && tcp.routeplusRoute != null) { route = tcp.routeplusRoute; }
        if (tcp.routeplusClosed === true) { alreadyClosed = true; }
    }
    clearTunnelSetupTimer(tcp);
    if (alreadyClosed === true) {
        route = null;
    } else {
        try { if (ws != null) { ws.routeplusClosed = true; } } catch (e) { }
        try { if (ws != null && ws.parent != null) { ws.parent.routeplusClosed = true; } } catch (e) { }
        try { if (tcp != null) { tcp.routeplusClosed = true; } } catch (e) { }
    }
    if (ws != null) {
        try { ws.end(); } catch (e) { debug(2, e); }
        try { ws.destroy(); } catch (e) { debug(2, e); }
    }
    if (tcp != null) {
        try { tcp.end(); } catch (e) { debug(2, e); }
        try { tcp.destroy(); } catch (e) { debug(2, e); }
        try { tcp.routeplusPendingData = []; tcp.routeplusPendingBytes = 0; } catch (e) { }
    }
    debug(1, "Tunnel disconnected: " + msg);
    noteTunnelClosed(route, wasActive, msg);
}

// Called when the web socket gets connected
function OnWebSocket(msg, s, head) {
    debug(1, "Websocket connected");
    configureTunnelSocket(s);
    s.on('data', function (msg) {
        if (this.parent.tunneling == false) {
            msg = msg.toString();
            if ((msg == 'c') || (msg == 'cr')) {
                if (this.parent.route != null) { this.parent.route.consecutiveFailures = 0; }
                clearTunnelSetupTimer(this.parent.tcp);
                var pendingData = [];
                if (this.parent.tcp != null) {
                    pendingData = this.parent.tcp.routeplusPendingData || [];
                    this.parent.tcp.routeplusPendingData = [];
                    this.parent.tcp.routeplusPendingBytes = 0;
                    this.parent.tcp.routeplusTunnelActive = true;
                }
                this.parent.tunneling = true; this.tunneling = true; this.pipe(this.parent.tcp, { dataTypeSkip: 1 });
                for (var i = 0; i < pendingData.length; i++) {
                    try { this.write(pendingData[i]); } catch (ex) { debug(2, ex); }
                }
                this.parent.tcp.pipe(this); debug(1, "Tunnel active");
            } else if ((msg.length > 6) && (msg.substring(0, 6) == 'error:')) {
                console.log(msg.substring(6));
                disconnectTunnel(this.tcp, this, msg.substring(6));
            }
        }
    });
    s.on('error', function (msg) { disconnectTunnel(this.tcp, this, 'Websocket error: ' + safeErrorString(msg)); });
    s.on('close', function (msg) { disconnectTunnel(this.tcp, this, 'Websocket closed'); });
    s.parent = this;
    s.tcp = this.tcp;
    s.route = this.route;
    s.routeplusClosed = false;
}

function OnRouteHealthProbeWebSocket(msg, s, head) {
    var probe = this.routeHealthProbe;
    if (probe == null) {
        try { s.end(); } catch (e) { }
        try { s.destroy(); } catch (e) { }
        return;
    }

    probe.socket = s;
    configureTunnelSocket(s);
    s.on('data', function (msg) {
        msg = msg.toString();
        if ((msg == 'c') || (msg == 'cr')) {
            finishRouteHealthProbe(probe, true, 'target port connected');
        } else if ((msg.length > 6) && (msg.substring(0, 6) == 'error:')) {
            finishRouteHealthProbe(probe, false, msg.substring(6));
        } else {
            finishRouteHealthProbe(probe, false, 'unexpected probe response: ' + msg.substring(0, 64));
        }
    });
    s.on('error', function (e) {
        finishRouteHealthProbe(probe, false, 'probe socket error: ' + safeErrorString(e));
    });
    s.on('close', function () {
        finishRouteHealthProbe(probe, false, 'probe socket closed before target connect');
    });
}

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };
