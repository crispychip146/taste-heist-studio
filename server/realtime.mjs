import { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { positiveInteger, setting, publicOrigin } from './limits.mjs';

export function createRealtime({ maxPerSeat = setting('WS_PER_SEAT', 3, 20), maxPerRoom = setting('WS_PER_ROOM', 12, 100), maxConnections = setting('WS_CONNECTIONS', 128, 10000), maxBufferedBytes = setting('WS_BUFFER_BYTES', 262144, 4000000), makeServer = options => new WebSocketServer(options) } = {}) {
  positiveInteger(maxPerSeat, 'WS_PER_SEAT', 20); positiveInteger(maxPerRoom, 'WS_PER_ROOM', 100);
  positiveInteger(maxConnections, 'WS_CONNECTIONS', 10000); positiveInteger(maxBufferedBytes, 'WS_BUFFER_BYTES', 4000000);
  const configuredOrigin = publicOrigin();
  const clients = new Map(); let app, heartbeat;
  const wss = makeServer({ noServer: true, maxPayload: 1024 });
  function terminate(socket) { clients.delete(socket); socket.terminate(); }
  function send(socket, room, session) {
    if (socket.readyState !== 1) return;
    try {
      const payload = JSON.stringify({ room: app.project(room, session.player) });
      if (socket.bufferedAmount + Buffer.byteLength(payload) > maxBufferedBytes) { terminate(socket); return; }
      socket.send(payload);
    } catch { terminate(socket); }
  }
  function broadcast(room) {
    for (const [socket, session] of clients) if (session.code === room.code && session.expires > Date.now()) send(socket, room, session);
  }
  function attach(server, application) {
    app = application;
    server.on('upgrade', (request, socket, head) => {
      try {
        const origin = configuredOrigin || `${request.socket?.encrypted ? 'https' : 'http'}://${request.headers.host}`;
        if (request.url !== '/live' || request.headers.origin !== origin) throw new Error('Origin');
        const { session, room } = app.authenticate(request);
        const peers = [...clients.values()];
        if (clients.size >= maxConnections || peers.filter(peer => peer.code === session.code).length >= maxPerRoom || peers.filter(peer => peer.player === session.player && peer.code === session.code).length >= maxPerSeat) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        wss.handleUpgrade(request, socket, head, ws => {
          clients.set(ws, session); ws.alive = true;
          ws.on('pong', () => { ws.alive = true; }); ws.on('error', () => ws.terminate()); ws.on('close', () => clients.delete(ws));
          send(ws, room, session);
        });
      } catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); }
    });
    heartbeat = setInterval(() => {
      for (const [socket, session] of clients) {
        if (!socket.alive || session.expires <= Date.now() || !app.store.get(session.code)) { terminate(socket); continue; }
        socket.alive = false; socket.ping();
      }
    }, 30000);
    heartbeat.unref?.();
  }
  function close() { clearInterval(heartbeat); for (const socket of clients.keys()) socket.terminate(); wss.close(); }
  return { attach, broadcast, close };
}
