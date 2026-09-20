/**
 * Boot the REAL relay out of server.js, with Next.js stubbed out.
 *
 * WHY THIS EXISTS. Every other relay suite in this repo MIRRORS server.js's
 * state machine in the test file ("server.js cannot be imported without booting
 * Next.js — this file MIRRORS the relay's pairing state machine. If you change
 * the logic in server.js, update this copy."). A mirror is fine for reasoning
 * about a state machine; it is worthless as proof that a CLIENT speaks the wire
 * protocol the shipped relay actually implements, because the mirror is written
 * by the same hand as the client and will agree with it by construction. The
 * soak runner's whole defect was exactly that class of mistake: the runner
 * "worked", against an imagined relay that pairs implicitly.
 *
 * So this boots the shipped file. server.js has no exports and calls main() at
 * module scope; main() only needs `next()` to hand back something with
 * prepare() + getRequestHandler(), and then it calls startRelay(httpServer) and
 * listens on PORT. Stubbing `next` through Module._load is therefore the whole
 * trick: every line of relay code — auth, entitlement, lobby, pairing, the
 * data-plane forward — is the real one.
 *
 * Nothing here is used by production. It is a test launcher and lives under
 * tests/ for that reason.
 *
 * Usage: PORT=<n> DATABASE_URL=<scratch> JWT_SECRET=<>=32> node tests/lib/relay-boot.cjs
 * Prints `RELAY_BOOTED <port>` on stdout once the socket is listening.
 */
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'next') {
    // The smallest shape main() uses: prepare(), getRequestHandler(), and a
    // writable didWebSocketSetup flag. It must NOT serve anything — the relay
    // upgrade handler is mounted on the same httpServer and is what we want.
    return function nextStub() {
      return {
        didWebSocketSetup: false,
        prepare: async () => {},
        getRequestHandler: () => (req, res) => { res.statusCode = 404; res.end('next stubbed'); },
      };
    };
  }
  return origLoad.apply(this, arguments);
};

// server.js logs the listen callback itself; announce on the same event by
// polling the server it created is not possible (no export), so we hook the
// http module's listen instead — the FIRST server to listen is main()'s.
const http = require('http');
const origCreate = http.createServer;
http.createServer = function wrapped(...args) {
  const s = origCreate.apply(this, args);
  const origListen = s.listen.bind(s);
  s.listen = (...largs) => {
    const r = origListen(...largs);
    s.once('listening', () => {
      const a = s.address();
      process.stdout.write(`RELAY_BOOTED ${typeof a === 'object' && a ? a.port : ''}\n`);
    });
    return r;
  };
  return s;
};

require(path.join(ROOT, 'server.js'));
