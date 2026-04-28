import { Saber } from './saber.js';
import { SmokeSystem } from './smoke.js';
import { AIOpponent } from './ai.js';
import { MSG } from './network.js';

const COLORS = {
  player:  { core: 'rgba(80, 220, 255, 1)',  glow: 'rgba(0, 150, 255, 1)',   smoke: 'rgba(0, 150, 255, 1)'  },
  ai:      { core: 'rgba(255, 80, 80, 1)',   glow: 'rgba(255, 20, 0, 1)',    smoke: 'rgba(255, 20, 0, 1)'   },
  guest:   { core: 'rgba(180, 80, 255, 1)',  glow: 'rgba(130, 0, 255, 1)',   smoke: 'rgba(130, 0, 255, 1)'  },
};

// Binary state packet: [type(u8), x(f32), y(f32), angle(f32), hp(f32)] = 17 bytes
const TYPE_STATE = 1;
const TYPE_HIT   = 2;

function encodeBinary(type, ...floats) {
  const buf = new ArrayBuffer(1 + floats.length * 4);
  const view = new DataView(buf);
  view.setUint8(0, type);
  floats.forEach((f, i) => view.setFloat32(1 + i * 4, f, true));
  return buf;
}

function isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function isMobileLandscape() {
  return isTouchDevice() && window.innerWidth > window.innerHeight;
}

export class Game {
  // net: pre-connected NetworkManager, or null for AI mode
  // handedness: 'right' (default) | 'left'
  constructor(canvas, mode = 'ai', net = null, handedness = 'right') {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.mode    = mode;
    this.net     = net;
    this.handedness = handedness;

    this.playerSaber   = new Saber(COLORS.player.core, COLORS.player.glow, 'player');
    this.opponentSaber = new Saber(
      mode === 'guest' ? COLORS.guest.core : COLORS.ai.core,
      mode === 'guest' ? COLORS.guest.glow : COLORS.ai.glow,
      'opponent'
    );

    this.smoke = new SmokeSystem(canvas);
    this.ai    = mode === 'ai' ? new AIOpponent(this.opponentSaber) : null;

    this.mouseX = 0; this.mouseY = 0;
    this.touchX = 0; this.touchY = 0; // raw touch coords
    this.running = false;
    this.winner  = null;
    this.clashCooldown = 0;
    this.sparkParticles = [];
    this.hitCooldown = 0;
    this.mobileLayout = false;
    this.logicalW = window.innerWidth;
    this.logicalH = window.innerHeight;

    // Bound event handlers
    this._raf = null;
    this._onResize      = this._resize.bind(this);
    this._onMouseMove   = this._trackMouse.bind(this);
    this._onTouchMove   = this._trackTouch.bind(this);
    this._onTouchStart  = this._trackTouch.bind(this);

    this._resize();
    window.addEventListener('resize', this._onResize);
    canvas.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
    canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });

    if (this.ai) {
      this.ai.linkPlayer(this.playerSaber);
      this.ai.setCenter(this.logicalW * 0.65, this.logicalH * 0.4);
    }

    if (this.net) this._wireNetwork();
  }

  start() {
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('mousemove',   this._onMouseMove);
    this.canvas.removeEventListener('touchmove',   this._onTouchMove);
    this.canvas.removeEventListener('touchstart',  this._onTouchStart);
  }

  setDifficulty(d) {
    if (this.ai) this.ai.setDifficulty(d);
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  _loop() {
    if (!this.running) return;
    this._update();
    this._draw();
    // Send binary state at frame rate (60fps) for minimal latency
    if (this.net && this.net.connected) {
      this._sendState();
    }
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _update() {
    if (this.winner) return;

    this.playerSaber.setTarget(this.mouseX, this.mouseY);
    this.playerSaber.update();

    if (this.ai) this.ai.update();

    this._emitBladeSmoke(this.playerSaber,   COLORS.player.smoke);
    this._emitBladeSmoke(this.opponentSaber, this.mode === 'guest' ? COLORS.guest.smoke : COLORS.ai.smoke);

    if (this.clashCooldown > 0) {
      this.clashCooldown--;
    } else if (Saber.intersects(this.playerSaber, this.opponentSaber)) {
      this._onClash();
    }

    if (this.hitCooldown > 0) {
      this.hitCooldown--;
    } else {
      this._checkHits();
    }

    this.smoke.update();
    this._updateSparks();

    if (this.playerSaber.hp   <= 0) { this.winner = 'opponent'; this._onGameEnd(); }
    if (this.opponentSaber.hp <= 0) { this.winner = 'player';   this._onGameEnd(); }
  }

  // ── Draw ───────────────────────────────────────────────────────────────────

  _draw() {
    const ctx = this.ctx;
    const w = this.logicalW, h = this.logicalH;

    ctx.fillStyle = '#030309';
    ctx.fillRect(0, 0, w, h);

    const floorGrad = ctx.createRadialGradient(w / 2, h * 0.75, 10, w / 2, h * 0.75, w * 0.6);
    floorGrad.addColorStop(0, 'rgba(40, 60, 120, 0.08)');
    floorGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, 0, w, h);

    // Mobile zone divider + hints
    if (this.mobileLayout) this._drawMobileZone(ctx, w, h);

    this.smoke.draw();

    // Sparks
    ctx.save();
    for (const s of this.sparkParticles) {
      const alpha = s.life / s.maxLife;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 2, s.y - s.vy * 2);
      ctx.strokeStyle = `hsla(${s.hue}, 100%, 80%, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.globalCompositeOperation = 'lighter';
      ctx.stroke();
    }
    ctx.restore();

    this.opponentSaber.draw(ctx);
    this.playerSaber.draw(ctx);

    // Touch ring cursor (mobile only)
    if (this.mobileLayout) this._drawTouchRing(ctx);

    this._drawHUD(ctx, w, h);
    if (this.winner) this._drawWinScreen(ctx, w, h);
  }

  _drawMobileZone(ctx, w, h) {
    const mid = w / 2;
    ctx.save();

    // Subtle center divider
    ctx.beginPath();
    ctx.moveTo(mid, 0);
    ctx.lineTo(mid, h);
    ctx.strokeStyle = 'rgba(80, 120, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.setLineDash([10, 14]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Your-side gradient tint
    const playerIsRight = this.handedness === 'right';
    const px = playerIsRight ? mid : 0;
    const tint = ctx.createLinearGradient(playerIsRight ? mid : w, 0, playerIsRight ? w : 0, 0);
    tint.addColorStop(0, 'rgba(0, 120, 255, 0.04)');
    tint.addColorStop(1, 'rgba(0, 120, 255, 0)');
    ctx.fillStyle = tint;
    ctx.fillRect(px, 0, mid, h);

    // "YOU" label at top of player's side
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#aaccff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('YOU', playerIsRight ? mid + mid / 2 : mid / 2, 14);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  _drawTouchRing(ctx) {
    if (this.touchX === 0 && this.touchY === 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.touchX, this.touchY, 18, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(80, 180, 255, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.touchX, this.touchY, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(80, 180, 255, 0.6)';
    ctx.fill();
    ctx.restore();
  }

  // ── HUD ────────────────────────────────────────────────────────────────────

  _drawHUD(ctx, w, h) {
    const barW = Math.min(200, w * 0.3);
    const barH = 10;
    const margin = 20;

    if (this.mobileLayout) {
      // On mobile landscape: HP bars at top of each half
      const mid = w / 2;
      const playerIsRight = this.handedness === 'right';
      const playerCX = playerIsRight ? mid + mid / 2 : mid / 2;
      const opponentCX = playerIsRight ? mid / 2 : mid + mid / 2;

      this._drawHPBar(ctx, playerCX   - barW / 2, margin, barW, barH, this.playerSaber.hp   / 100, COLORS.player.glow, 'YOU');
      this._drawHPBar(ctx, opponentCX - barW / 2, margin, barW, barH, this.opponentSaber.hp / 100,
        this.mode === 'guest' ? COLORS.guest.glow : COLORS.ai.glow,
        this.mode === 'ai' ? 'AI' : 'RIVAL');
    } else {
      // Desktop: HP bars at bottom corners
      this._drawHPBar(ctx, margin, h - margin - barH, barW, barH, this.playerSaber.hp   / 100, COLORS.player.glow, 'YOU');
      this._drawHPBar(ctx, w - margin - barW, h - margin - barH, barW, barH, this.opponentSaber.hp / 100,
        this.mode === 'guest' ? COLORS.guest.glow : COLORS.ai.glow,
        this.mode === 'ai' ? 'AI' : 'RIVAL');
    }
  }

  _drawHPBar(ctx, x, y, w, h, pct, color, label) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill();
    const grad = ctx.createLinearGradient(x, y, x + w * pct, y);
    grad.addColorStop(0, color.replace('1)', '0.5)'));
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(x, y, w * pct, h, 3); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, y - 3);
    ctx.restore();
  }

  // ── Win screen ─────────────────────────────────────────────────────────────

  _drawWinScreen(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);

    const text  = this.winner === 'player' ? 'VICTORY' : 'DEFEATED';
    const sub   = this.winner === 'player' ? 'You mastered the blade.' : 'The force was not with you.';
    const color = this.winner === 'player' ? COLORS.player.glow : COLORS.ai.glow;

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalCompositeOperation = 'lighter';

    ctx.font      = `bold ${Math.min(72, w * 0.12)}px "Orbitron", monospace`;
    ctx.fillStyle = color.replace('1)', '0.3)');
    ctx.fillText(text, w / 2, h / 2);

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, w / 2, h / 2);

    ctx.font      = '16px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(sub, w / 2, h / 2 + 54);
    ctx.font      = '12px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('Tap to play again', w / 2, h / 2 + 80);
    ctx.restore();
  }

  // ── Physics helpers ────────────────────────────────────────────────────────

  _emitBladeSmoke(saber, color) {
    const [tx, ty, bx, by] = saber.getEndpoints();
    const speed = Math.sqrt(saber.vx ** 2 + saber.vy ** 2);
    if (speed > 0.5) {
      for (let t = 0; t <= 1; t += 0.5) {
        const ex = bx + (tx - bx) * t;
        const ey = by + (ty - by) * t;
        this.smoke.emit(ex, ey, color, 1, speed * 0.3);
      }
    }
  }

  _onClash() {
    this.clashCooldown = 8;
    const [tx, ty] = this.playerSaber.getEndpoints();
    const [ox, oy] = this.opponentSaber.getEndpoints();
    const mx = (tx + ox) / 2, my = (ty + oy) / 2;
    this.smoke.emit(mx, my, COLORS.player.smoke, 6, 3);
    this.smoke.emit(mx, my, this.mode === 'guest' ? COLORS.guest.smoke : COLORS.ai.smoke, 6, 3);
    this._emitSparks(mx, my, 20);
    this.playerSaber.vx -= (mx - this.playerSaber.x) * 0.1;
    this.playerSaber.vy -= (my - this.playerSaber.y) * 0.1;
  }

  _checkHits() {
    const [ptx, pty] = this.playerSaber.getEndpoints(); // tip
    const [otx, oty] = this.opponentSaber.getEndpoints();
    const distPO = Math.hypot(ptx - this.opponentSaber.x, pty - this.opponentSaber.y);
    const distOP = Math.hypot(otx - this.playerSaber.x,   oty - this.playerSaber.y);
    const hitRange = 30;

    if (distPO < hitRange) {
      const dmg = 8 + Math.random() * 6;
      this.opponentSaber.hp = Math.max(0, this.opponentSaber.hp - dmg);
      this.opponentSaber.hitFlash = 10;
      this._emitSparks(this.opponentSaber.x, this.opponentSaber.y, 10);
      this.hitCooldown = 25;
      if (this.net) this.net.sendRaw(encodeBinary(TYPE_HIT, dmg));
    } else if (distOP < hitRange) {
      const dmg = 6 + Math.random() * 4;
      this.playerSaber.hp = Math.max(0, this.playerSaber.hp - dmg);
      this.playerSaber.hitFlash = 10;
      this._emitSparks(this.playerSaber.x, this.playerSaber.y, 10);
      this.hitCooldown = 25;
    }
  }

  _dist(a, b) {
    const [tx, ty] = a.getEndpoints();
    return Math.hypot(tx - b.x, ty - b.y);
  }

  _emitSparks(x, y, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd   = 2 + Math.random() * 5;
      this.sparkParticles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 1,
        life: 15 + Math.random() * 15,
        maxLife: 30,
        hue: Math.random() > 0.5 ? 200 : 30,
      });
    }
  }

  _updateSparks() {
    for (let i = this.sparkParticles.length - 1; i >= 0; i--) {
      const s = this.sparkParticles[i];
      s.x += s.vx; s.y += s.vy;
      s.vy += 0.15;
      s.vx *= 0.96;
      s.life--;
      if (s.life <= 0) this.sparkParticles.splice(i, 1);
    }
  }

  // ── Network ────────────────────────────────────────────────────────────────

  _sendState() {
    this.net.sendRaw(encodeBinary(
      TYPE_STATE,
      this.playerSaber.x,
      this.playerSaber.y,
      this.playerSaber.angle,
      this.playerSaber.hp
    ));
  }

  // Mirror opponent X for mobile layout (they play on their "right", we see them on our "left")
  _mirrorX(x) {
    if (this.mobileLayout && (this.mode === 'host' || this.mode === 'guest')) {
      return this.logicalW - x;
    }
    return x;
  }

  _wireNetwork() {
    this.net.addEventListener('rawmessage', (e) => {
      const buf  = e.detail;
      const view = new DataView(buf);
      const type = view.getUint8(0);

      if (type === TYPE_STATE) {
        const rx = view.getFloat32(1, true);
        const ry = view.getFloat32(5, true);
        const ra = view.getFloat32(9, true);
        const rh = view.getFloat32(13, true);
        this.opponentSaber.setTarget(this._mirrorX(rx), ry);
        this.opponentSaber.angle = ra;
        // Authoritative HP sync (clamp to avoid cheating drift)
        if (Math.abs(this.opponentSaber.hp - rh) > 2) this.opponentSaber.hp = rh;
      }

      if (type === TYPE_HIT) {
        const dmg = view.getFloat32(1, true);
        this.playerSaber.hp = Math.max(0, this.playerSaber.hp - dmg);
        this.playerSaber.hitFlash = 10;
      }
    });

    this.net.addEventListener('disconnected', () => {
      this.winner = 'player'; // treat disconnect as win
      this._onGameEnd();
    });
  }

  _onGameEnd() {
    if (this.net) this.net.disconnect();
    this.canvas.addEventListener('click',     () => window.location.reload(), { once: true });
    this.canvas.addEventListener('touchstart', () => window.location.reload(), { once: true });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  _trackMouse(e) {
    const rect   = this.canvas.getBoundingClientRect();
    const scaleX = this.logicalW / rect.width;
    const scaleY = this.logicalH / rect.height;
    this.mouseX  = (e.clientX - rect.left) * scaleX;
    this.mouseY  = (e.clientY - rect.top)  * scaleY;
  }

  _trackTouch(e) {
    e.preventDefault();
    const touch  = e.touches[0];
    if (!touch) return;
    const rect   = this.canvas.getBoundingClientRect();
    const scaleX = this.logicalW / rect.width;
    const scaleY = this.logicalH / rect.height;
    const x = (touch.clientX - rect.left) * scaleX;
    const y = (touch.clientY - rect.top)  * scaleY;
    this.touchX  = x;
    this.touchY  = y;
    this.mouseX  = x;
    this.mouseY  = y;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w   = window.innerWidth;
    const h   = window.innerHeight;
    this.logicalW = w;
    this.logicalH = h;
    this.mobileLayout = isMobileLandscape();

    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); // reset before re-scaling
    this.ctx.scale(dpr, dpr);

    // Reposition AI center for the side it lives on
    if (this.ai) {
      const aiSideX = this.handedness === 'right' ? w * 0.3 : w * 0.7;
      this.ai.setCenter(aiSideX, h * 0.4);
    }

    // Default saber start positions
    if (this.mobileLayout) {
      const playerX = this.handedness === 'right' ? w * 0.75 : w * 0.25;
      this.mouseX = playerX;
      this.mouseY = h * 0.5;
    } else {
      this.mouseX = w * 0.35;
      this.mouseY = h * 0.5;
    }
  }
}
