// Online multiplayer via PeerJS (WebRTC data channels — no server required).
// Uses binary ArrayBuffer packets (17 bytes/state vs ~60 bytes JSON) for ultra-low latency.
export class NetworkManager extends EventTarget {
  constructor() {
    super();
    this.peer      = null;
    this.conn      = null;
    this.role      = null; // 'host' | 'guest'
    this.roomCode  = null;
    this.connected = false;
    this._queue    = [];
  }

  async host() {
    await this._initPeer();
    this.role = 'host';
    this.roomCode = this.peer.id;

    this.peer.on('connection', (conn) => {
      this.conn = conn;
      this._wireConn();
      this.dispatchEvent(new CustomEvent('connected', { detail: { role: 'host' } }));
    });

    return this.roomCode;
  }

  async join(code) {
    await this._initPeer();
    this.role = 'guest';
    this.roomCode = code.toUpperCase().trim();
    this.conn = this.peer.connect(this.roomCode, {
      reliable: false,        // unordered/unreliable = UDP-like, lowest latency
      serialization: 'raw',   // pass ArrayBuffer directly, no msgpack overhead
    });
    this._wireConn();
    return new Promise((resolve, reject) => {
      this.conn.on('open', resolve);
      this.conn.on('error', reject);
      setTimeout(() => reject(new Error('Timed out')), 15000);
    });
  }

  // Simplified random matchmaking: host side opens, guest side connects via stored lobby code.
  // Both sides poll peerjs.com (no dedicated server needed).
  async matchRandom(onWaiting) {
    await this._initPeer();
    this.role = 'host'; // starts as host, may become guest if someone connects first

    this.peer.on('connection', (conn) => {
      this.conn = conn;
      this._wireConn();
      this.dispatchEvent(new CustomEvent('connected', { detail: { role: 'host', random: true } }));
    });

    onWaiting && onWaiting(this.peer.id);
    return this.peer.id;
  }

  // Send raw ArrayBuffer — the primary path for game state (called every frame)
  sendRaw(buf) {
    if (this.conn && this.conn.open) {
      this.conn.send(buf);
    } else {
      this._queue.push(buf);
    }
  }

  // Legacy JSON send (for control messages like READY, RESULT)
  send(type, data) {
    this.sendRaw(this._encodeJson({ type, data }));
  }

  disconnect() {
    if (this.conn)  { this.conn.close();   this.conn = null;  }
    if (this.peer)  { this.peer.destroy(); this.peer = null;  }
    this.connected = false;
  }

  _encodeJson(obj) {
    const str  = JSON.stringify(obj);
    const enc  = new TextEncoder();
    const arr  = enc.encode(str);
    const buf  = new ArrayBuffer(1 + arr.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, 0); // type 0 = JSON control message
    new Uint8Array(buf, 1).set(arr);
    return buf;
  }

  _initPeer() {
    return new Promise((resolve, reject) => {
      if (this.peer && !this.peer.destroyed) { resolve(); return; }
      this.peer = new Peer(undefined, {
        host: '0.peerjs.com', port: 443, secure: true, path: '/',
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ]
        }
      });
      this.peer.on('open',  resolve);
      this.peer.on('error', (err) => {
        this.dispatchEvent(new CustomEvent('error', { detail: err.message }));
        reject(err);
      });
    });
  }

  _wireConn() {
    this.conn.on('open', () => {
      this.connected = true;
      while (this._queue.length) this.conn.send(this._queue.shift());
    });

    this.conn.on('data', (raw) => {
      // raw is ArrayBuffer (serialization: 'raw') or Blob depending on browser
      if (raw instanceof ArrayBuffer) {
        this.dispatchEvent(new CustomEvent('rawmessage', { detail: raw }));
      } else if (raw instanceof Blob) {
        raw.arrayBuffer().then(buf =>
          this.dispatchEvent(new CustomEvent('rawmessage', { detail: buf }))
        );
      }
    });

    this.conn.on('close', () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
    });

    this.conn.on('error', (err) =>
      this.dispatchEvent(new CustomEvent('error', { detail: err.message }))
    );
  }
}

export const MSG = { STATE: 'state', HIT: 'hit', READY: 'ready', RESULT: 'result' };
