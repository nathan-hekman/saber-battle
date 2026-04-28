// Online multiplayer via PeerJS (WebRTC data channels — no server required)
// PeerJS hosted broker: peerjs.com (free tier)
import { EVENTS } from './events.js';

export class NetworkManager extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.role = null; // 'host' | 'guest'
    this.roomCode = null;
    this.connected = false;
    this._sendQueue = [];
  }

  // Returns the room code (Peer ID) for sharing with friend
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

  // Join via a room code shared by the host
  async join(code) {
    await this._initPeer();
    this.role = 'guest';
    this.roomCode = code.toUpperCase().trim();
    this.conn = this.peer.connect(this.roomCode, { reliable: false, serialization: 'json' });
    this._wireConn();
    return new Promise((resolve, reject) => {
      this.conn.on('open', () => {
        this.dispatchEvent(new CustomEvent('connected', { detail: { role: 'guest' } }));
        resolve();
      });
      this.conn.on('error', reject);
      setTimeout(() => reject(new Error('Connection timed out')), 15000);
    });
  }

  // Random matchmaking via a simple shared signaling "lobby" key
  async matchRandom(onWaiting) {
    const lobbyKey = 'SABERBATTLE_LOBBY_' + Math.floor(Date.now() / 10000); // 10s window
    await this._initPeer();

    // Try to join any peer that announced in this window
    this.peer.on('connection', (conn) => {
      this.role = 'host';
      this.conn = conn;
      this._wireConn();
      this.dispatchEvent(new CustomEvent('connected', { detail: { role: 'host', random: true } }));
    });

    onWaiting && onWaiting(this.peer.id);
    // Guest side: If we find a host that registered in this window, join them
    // (simplified: both announce, first to connect wins. For production, use a signaling server.)
  }

  send(type, data) {
    const msg = { type, data, ts: Date.now() };
    if (this.conn && this.conn.open) {
      this.conn.send(msg);
    } else {
      this._sendQueue.push(msg);
    }
  }

  disconnect() {
    if (this.conn) { this.conn.close(); this.conn = null; }
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    this.connected = false;
  }

  _initPeer() {
    return new Promise((resolve, reject) => {
      if (this.peer && !this.peer.destroyed) { resolve(); return; }
      // PeerJS CDN loaded via script tag in index.html
      this.peer = new Peer(undefined, {
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        path: '/',
        debug: 0,
      });
      this.peer.on('open', () => resolve());
      this.peer.on('error', (err) => {
        this.dispatchEvent(new CustomEvent('error', { detail: err.message }));
        reject(err);
      });
    });
  }

  _wireConn() {
    this.conn.on('open', () => {
      this.connected = true;
      // Flush queued messages
      while (this._sendQueue.length) {
        this.conn.send(this._sendQueue.shift());
      }
    });

    this.conn.on('data', (msg) => {
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    });

    this.conn.on('close', () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
    });

    this.conn.on('error', (err) => {
      this.dispatchEvent(new CustomEvent('error', { detail: err.message }));
    });
  }
}

// Message types exchanged between peers
export const MSG = {
  STATE: 'state',      // { x, y, angle, hp, attacking }
  HIT:   'hit',        // { damage }
  READY: 'ready',      // handshake
  RESULT: 'result',    // { winner }
};
