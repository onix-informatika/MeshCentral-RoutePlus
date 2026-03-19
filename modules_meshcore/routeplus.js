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
var latestAuthCookie = null;
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
                        dbg('Start / rebuild command sent when data has not changed and already listening. Leaving in tact and doing nothing.');
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
            latestAuthCookie = args.rauth;
            var r = new RoutePlusRoute();
            var settings = {
                mapid: args.mid,
                serverurl: ((typeof args.relayurl == 'string') && (args.relayurl.length > 0)) ? args.relayurl : mesh.ServerUrl.replace('agent.ashx', 'meshrelay.ashx'),
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
            latestAuthCookie = args.rauth;
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
    rObj.startRouter = startRouter;
    rObj.debug = debug;
    rObj.OnTcpClientConnected = function (c) {
        try {
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
            c.on('end', function () { disconnectTunnel(this, this.websocket, "Client closed"); });
            c.on('close', function () { disconnectTunnel(this, this.websocket, "Client socket closed"); });
            c.on('error', function () { disconnectTunnel(this, this.websocket, "Client socket error"); });
            c.pause();
            try {
                var options = http.parseUri(rObj.settings.serverurl + '?noping=1&auth=' + latestAuthCookie + '&nodeid=' + rObj.settings.remotenodeid + '&tcpport=' + rObj.settings.remoteport + (rObj.settings.remotetarget == null ? '' : '&tcpaddr=' + rObj.settings.remotetarget));
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
            c.websocket.tunneling = false;
            c.websocket.upgrade = OnWebSocket;
            c.websocket.on('error', function (e) {
                dbg("ERROR: " + JSON.stringify(e));
                reportRouteError(rObj.settings.mapid, 'websocketRequestError', e, rObj.settings.localport);
                disconnectTunnel(this.tcp, this, "Websocket request error");
            });
            c.websocket.end();
        } catch (e) {
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
    if (ws != null) {
        try { ws.end(); } catch (e) { debug(2, e); }
        try { ws.destroy(); } catch (e) { debug(2, e); }
    }
    if (tcp != null) {
        try { tcp.end(); } catch (e) { debug(2, e); }
        try { tcp.destroy(); } catch (e) { debug(2, e); }
    }
    debug(1, "Tunnel disconnected: " + msg);
}

// Called when the web socket gets connected
function OnWebSocket(msg, s, head) {
    debug(1, "Websocket connected");
    s.on('data', function (msg) {
        if (this.parent.tunneling == false) {
            msg = msg.toString();
            if ((msg == 'c') || (msg == 'cr')) {
                this.parent.tunneling = true; this.pipe(this.parent.tcp); this.parent.tcp.pipe(this); debug(1, "Tunnel active");
            } else if ((msg.length > 6) && (msg.substring(0, 6) == 'error:')) {
                console.log(msg.substring(6));
                disconnectTunnel(this.tcp, this, msg.substring(6));
            }
        }
    });
    s.on('error', function (msg) { disconnectTunnel(this.tcp, this, 'Websocket error'); });
    s.on('close', function (msg) { disconnectTunnel(this.tcp, this, 'Websocket closed'); });
    s.parent = this;
}

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };
