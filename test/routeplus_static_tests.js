const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeplusCore = fs.readFileSync(
  path.join(__dirname, '..', 'modules_meshcore', 'routeplus.js'),
  'utf8'
);
const routeplusServer = fs.readFileSync(
  path.join(__dirname, '..', 'routeplus.js'),
  'utf8'
);
const routeplusDb = fs.readFileSync(
  path.join(__dirname, '..', 'db.js'),
  'utf8'
);

assert(
  !routeplusCore.includes("'?noping=1&auth=' + latestAuthCookie"),
  'RoutePlus must not use a single global auth cookie for all routes'
);

assert(
  routeplusCore.includes('function buildRouteRelayOptions(settings)') &&
    routeplusCore.includes("'?noping=1&auth=' + encodeURIComponent(settings.authCookie)"),
  'RoutePlus should use the auth cookie stored on the route being opened'
);

assert(
  routeplusCore.includes('setKeepAlive(true'),
  'RoutePlus should enable TCP keepalive for long-lived SQL tunnels'
);

assert(
  routeplusCore.includes('setNoDelay(true'),
  'RoutePlus should disable Nagle delays for interactive tunnel traffic'
);

assert(
  routeplusCore.includes('this.pipe(this.parent.tcp, { dataTypeSkip: 1 })'),
  'RoutePlus should strip the MeshCentral relay data-type byte before forwarding SQL tunnel bytes'
);

assert(
  !routeplusCore.includes('restartAfterCompletedTunnels') &&
    !routeplusCore.includes('completed tunnel threshold'),
  'RoutePlus must not restart just because normal client tunnels completed'
);

assert(
  routeplusCore.includes('scheduleRouteHealthProbe') &&
    routeplusCore.includes('OnRouteHealthProbeWebSocket'),
  'RoutePlus should probe the mapped target port before recreating a route'
);

assert(
  routeplusCore.includes('requestRouteRestart'),
  'RoutePlus should schedule route restarts through a single restart path'
);

assert(
  routeplusCore.includes('requestRouteRestart(probe.route'),
  'RoutePlus should recreate routes from failed target-port health probes'
);

assert(
  routeplusCore.includes('c.routeplusRoute = rObj'),
  'RoutePlus should attach route ownership before websocket setup so early failures are counted'
);

assert(
  routeplusCore.includes('tcp.routeplusClosed'),
  'RoutePlus should count each tunnel close once even when both TCP and websocket close events fire'
);

assert(
  routeplusCore.includes("disconnectTunnel(c, c.websocket, 'Connection setup exception')"),
  'RoutePlus should route setup exceptions through the shared cleanup path'
);

assert(
  routeplusCore.includes('tunnelSetupTimeoutMs = 5000') &&
    routeplusCore.includes('Tunnel setup timeout') &&
    routeplusCore.includes('clearTunnelSetupTimer(this.parent.tcp)'),
  'RoutePlus should clean up pending tunnel setup sockets before they fill the accept queue'
);

assert(
  routeplusCore.includes('routeplusPendingData') &&
    routeplusCore.includes('maxPendingTunnelBytes') &&
    routeplusCore.includes('pendingData[i]') &&
    !routeplusCore.includes('c.pause()'),
  'RoutePlus should buffer early client bytes instead of leaving pre-login data paused in the kernel socket'
);

assert(
  routeplusServer.includes('createRouteAuthCookie') &&
    routeplusServer.includes('Date.now() + obj.routeAuthCookieLifetimeMs') &&
    !routeplusServer.includes('expire: 0'),
  'RoutePlus should use future relay auth expiration timestamps for long-lived service tunnels'
);

assert(
  routeplusDb.includes('getAllMyComputers') &&
    routeplusServer.includes('routeAuthRefreshIntervalMs = 30 * 60 * 1000') &&
    routeplusServer.includes('obj.refreshAllOnlineRoutes'),
  'RoutePlus should periodically refresh route auth cookies for online source agents'
);

assert(
  !routeplusServer.includes('onlineUsers.indexOf') &&
    routeplusServer.includes('obj.startUserRoutes(my.user, my.node)'),
  'RoutePlus should start persisted source-agent routes without requiring an open web UI session'
);

assert(
  routeplusDb.includes('getMapsToNode') &&
    routeplusServer.includes('obj.db.getMapsToNode(checkedInNode)'),
  'RoutePlus should refresh routes when mapped target agents check in'
);

assert(
  routeplusServer.includes('targetAgentOffline') &&
    routeplusServer.includes('obj.endRoute(map._id)'),
  'RoutePlus should close local listeners for targets MeshCentral knows are offline'
);

assert(
  routeplusCore.includes('resetRouteHealthState') &&
    routeplusCore.includes('websocketHttpResponse') &&
    routeplusCore.includes('probe HTTP response'),
  'RoutePlus should reset unhealthy state on route refresh and report relay auth HTTP failures'
);
