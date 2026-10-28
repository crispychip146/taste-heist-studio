import { WebSocketServer } from '../vendor/ws/wrapper.mjs';

export function createRealtime() {
  const clients = new Map(); let app, heartbeat;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  function broadcast(room) {
    for (const [socket, session] of clients) if (session.code === room.code && session.expires > Date.now() && socket.readyState === 1) socket.send(JSON.stringify({ room: app.project(room, session.player) }));
  }
  function attach(server, application) {
    app = application;
    server.on('upgrade', (request, socket, head) => {
      try {
        const origin = process.env.PUBLIC_ORIGIN || `http://${request.headers.host}`;
        if (request.url !== '/live' || request.headers.origin !== origin) throw new Error('Origin');
        const { session, room } = app.authenticate(request);
        wss.handleUpgrade(request, socket, head, ws => {
          clients.set(ws, session); ws.alive = true;
          ws.on('pong', () => { ws.alive = true; }); ws.on('error', () => ws.terminate()); ws.on('close', () => clients.delete(ws));
          ws.send(JSON.stringify({ room: app.project(room, session.player) }));
        });
      } catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); }
    });
    heartbeat = setInterval(() => {
      for (const [socket, session] of clients) {
        if (!socket.alive || session.expires <= Date.now() || !app.store.get(session.code)) { socket.terminate(); continue; }
        socket.alive = false; socket.ping();
      }
    }, 30000);
  }
  function close() { clearInterval(heartbeat); for (const socket of clients.keys()) socket.terminate(); wss.close(); }
  return { attach, broadcast, close };
}
