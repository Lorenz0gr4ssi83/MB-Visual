// connect() di "cloudflare:sockets" imitato con net/tls di Node, per provare server/src/mailgw.js senza Cloudflare.
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";

function wrap(sock, opened) {
  const web = Duplex.toWeb(sock);
  return {
    readable: web.readable, writable: web.writable, opened,
    close() { sock.destroy(); },
    startTls() {
      const t = tls.connect({ socket: sock, servername: sock._mbvHost });
      t._mbvHost = sock._mbvHost;
      return wrap(t, new Promise((res, rej) => { t.once("secureConnect", res); t.once("error", rej); }));
    },
  };
}

export function nodeConnect({ hostname, port }, { secureTransport = "off" } = {}) {
  const sock = secureTransport === "on" ? tls.connect({ host: hostname, port, servername: hostname }) : net.connect({ host: hostname, port });
  sock._mbvHost = hostname;
  const opened = new Promise((res, rej) => { sock.once(secureTransport === "on" ? "secureConnect" : "connect", res); sock.once("error", rej); });
  return wrap(sock, opened);
}
