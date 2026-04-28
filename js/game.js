import { Saber } from './saber.js';
import { SmokeSystem } from './smoke.js';
import { AIOpponent } from './ai.js';
import { NetworkManager, MSG } from './network.js';

const COLORS = {
  player: {
    core: 'rgba(80, 220, 255, 1)',
    glow: 'rgba(0, 150, 255, 1)',
    smoke: 'rgba(0, 150, 255, 1)',
  },
  ai: {
    core: 'rgba(255, 80, 80, 1)',
    glow: 'rgba(255, 20, 0, 1)',
    smoke: 'rgba(255, 20, 0, 1)',
  },
  guest: {
    core: 'rgba(180, 80, 255, 1)',
    glow: 'rgba(130, 0, 255, 1)',
    smoke: 'rgba(130, 0, 255, 1)',
  },
};

export class Game {
  // net: pre-connected NetworkManager instance (for online modes), or null for AI
  constructor(canvas, mode = 'ai', net = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = mode; // 'ai' | 'host' | 'guest'

    this.playerSaber = new Saber(COLORS.player.core, COLORS.player.glow, 'player');
    this.opponentSaber = new Saber(
      mode === 'guest' ? COLORS.guest.core : COLORS.ai.core,
      mode === 'guest' ? COLORS.guest.glow : COLORS.ai.glow,
      'opponent'
    );

    this.smoke = new SmokeSystem(canvas);
    this.ai = mode === 'ai' ? new AIOpponent(this.opponentSaber) : null;
    this.net = net;

    this.mouseX = canvas.width / 2;
    this.mouseY = canvas.height / 2;
    this.running = false;
    this.winner = null;
    this.clashCooldown = 0;
    this.sparkParticles = [];
    this.hitCooldown = 0;

    this._raf = null;
    this._onResize = this._resize.bind(this);
    this._onMouseMove = this._trackMouse.bind(this);
    this._onTouchMove = this._trackTouch.bind(this);

    this._resize();
    window.addEventListener('resize', this._onResize);
    canvas.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });

    if (this.ai) {
      this.ai.linkPlayer(this.playerSaber);
      this.ai.setCenter(canvas.width * 0.65, canvas.height * 0.4);
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
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('touchmove', this._onTouchMove);
  }

  setDifficulty(d) {
    if (this.ai) this.ai.setDifficulty(d);
  }

  _loop() {
    if (!this.running) return;
    this._update();
    this._draw();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _update() {
    if (this.winner) return;

    // Player saber tracks mouse
    this.playerSaber.setTarget(this.mouseX, this.mouseY);
    this.playerSaber.update();

    // Opponent: AI or networked
    if (this.ai) {
      this.ai.update();
    }

    // Emit continuous smoke along blade
    this._emitBladeSmoke(this.playerSaber, COLORS.player.smoke);
    this._emitBladeSmoke(this.opponentSaber, COLORS.ai.smoke);

    // Collision detection
    if (this.clashCooldown > 0) {
      this.clashCooldown--;
    } else if (Saber.intersects(this.playerSaber, this.opponentSaber)) {
      this._onClash();
    }

    // Hit detection — if player saber tip is near opponent center
    if (this.hitCooldown > 0) {
      this.hitCooldown--;
    } else {
      this._checkHits();
    }

    this.smoke.update();
    this._updateSparks();

    // Win condition
    if (this.playerSaber.hp <= 0) { this.winner = 'opponent'; this._onGameEnd(); }
    if (this.opponentSaber.hp <= 0) { this.winner = 'player'; this._onGameEnd(); }
  }

  _emitBladeSmoke(saber, color) {
    const [tx, ty, bx, by] = saber.getEndpoints();
    const speed = Math.sqrt(saber.vx ** 2 + saber.vy ** 2);
    if (speed > 0.5) {
      // Emit along blade at 3 points
      for (let t = 0; t <= 1; t += 0.5) {
        const ex = bx + (tx - bx) * t;
        const ey = by + (ty - by) * t;
        this.smoke.emit(ex, ey, color, 1, speed * 0.3);
      }
    }
  }

  _onClash() {
    this.clashCooldown = 8;
    const [tx, ty, bx, by] = this.playerSaber.getEndpoints();
    const [ox, oy] = this.opponentSaber.getEndpoints();
    // Find approximate intersection midpoint
    const mx = (tx + ox) / 2;
    const my = (ty + oy) / 2;
    // Big smoke burst at clash point
    this.smoke.emit(mx, my, COLORS.player.smoke, 6, 3);
    this.smoke.emit(mx, my, COLORS.ai.smoke, 6, 3);
    // Sparks
    this._emitSparks(mx, my, 20);
    // Slight knockback
    this.playerSaber.vx -= (mx - this.playerSaber.x) * 0.1;
    this.playerSaber.vy -= (my - this.playerSaber.y) * 0.1;
  }

  _checkHits() {
    const distPO = this._dist(this.playerSaber, this.opponentSaber);
    const distOP = this._dist(this.opponentSaber, this.playerSaber);
    const hitRange = 30;

    if (distPO < hitRange) {
      const dmg = 8 + Math.random() * 6;
      this.opponentSaber.hp = Math.max(0, this.opponentSaber.hp - dmg);
      this.opponentSaber.hitFlash = 10;
      this._emitSparks(this.opponentSaber.x, this.opponentSaber.y, 10);
      this.hitCooldown = 25;
      if (this.net) this.net.send(MSG.HIT, { damage: dmg });
    } else if (distOP < hitRange) {
      const dmg = 6 + Math.random() * 4;
      this.playerSaber.hp = Math.max(0, this.playerSaber.hp - dmg);
      this.playerSaber.hitFlash = 10;
      this._emitSparks(this.playerSaber.x, this.playerSaber.y, 10);
      this.hitCooldown = 25;
    }
  }

  _dist(a, b) {
    const [tx, ty] = a.getEndpoints(); // tip
    return Math.sqrt((tx - b.x) ** 2 + (ty - b.y) ** 2);
  }

  _emitSparks(x, y, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 2 + Math.random() * 5;
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
      s.vy += 0.15; // gravity
      s.vx *= 0.96;
      s.life--;
      if (s.life <= 0) this.sparkParticles.splice(i, 1);
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;

    // Background — deep space with radial ambient
    ctx.fillStyle = '#030309';
    ctx.fillRect(0, 0, w, h);

    // Subtle arena floor reflection
    const floorGrad = ctx.createRadialGradient(w / 2, h * 0.75, 10, w / 2, h * 0.75, w * 0.6);
    floorGrad.addColorStop(0, 'rgba(40, 60, 120, 0.08)');
    floorGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, 0, w, h);

    // Smoke layer (under sabers)
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

    // Sabers
    this.opponentSaber.draw(ctx);
    this.playerSaber.draw(ctx);

    // HUD
    this._drawHUD(ctx, w, h);

    // Win screen overlay
    if (this.winner) this._drawWinScreen(ctx, w, h);
  }

  _drawHUD(ctx, w, h) {
    const barW = 200, barH = 12, margin = 24;

    // Player HP (bottom-left)
    this._drawHPBar(ctx, margin, h - margin - barH, barW, barH,
      this.playerSaber.hp / 100, COLORS.player.glow, 'YOU');

    // Opponent HP (bottom-right)
    this._drawHPBar(ctx, w - margin - barW, h - margin - barH, barW, barH,
      this.opponentSaber.hp / 100, COLORS.ai.glow,
      this.mode === 'ai' ? 'AI' : 'RIVAL');
  }

  _drawHPBar(ctx, x, y, w, h, pct, color, label) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    // Background
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
    // Fill
    const grad = ctx.createLinearGradient(x, y, x + w * pct, y);
    grad.addColorStop(0, color.replace('1)', '0.6)'));
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, w * pct, h, 4);
    ctx.fill();
    // Label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, y - 4);
    ctx.restore();
  }

  _drawWinScreen(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);

    const text = this.winner === 'player' ? 'VICTORY' : 'DEFEATED';
    const sub = this.winner === 'player' ? 'You mastered the blade.' : 'The force was not with you.';
    const color = this.winner === 'player' ? COLORS.player.glow : COLORS.ai.glow;

    ctx.globalCompositeOperation = 'lighter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Glow
    ctx.font = 'bold 90px "Orbitron", monospace';
    ctx.fillStyle = color.replace('1)', '0.15)');
    ctx.fillText(text, w / 2, h / 2);
    ctx.fillStyle = color.replace('1)', '0.4)');
    ctx.fillText(text, w / 2, h / 2);

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 72px "Orbitron", monospace';
    ctx.fillText(text, w / 2, h / 2);
    ctx.font = '18px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(sub, w / 2, h / 2 + 60);
    ctx.font = '14px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText('Click to play again', w / 2, h / 2 + 95);

    ctx.restore();
  }

  _onGameEnd() {
    if (this.net) {
      this.net.send(MSG.RESULT, { winner: this.winner === 'player' ? 'guest' : 'host' });
    }
    this.canvas.addEventListener('click', () => window.location.reload(), { once: true });
  }

  _wireNetwork() {
    this.net.addEventListener('message', (e) => {
      const { type, data } = e.detail;
      if (type === MSG.STATE) {
        this.opponentSaber.setTarget(data.x, data.y);
      }
      if (type === MSG.HIT) {
        this.playerSaber.hp = Math.max(0, this.playerSaber.hp - data.damage);
        this.playerSaber.hitFlash = 10;
      }
    });

    // Broadcast player state every frame
    const sendState = () => {
      if (this.running && this.net) {
        this.net.send(MSG.STATE, {
          x: this.playerSaber.x,
          y: this.playerSaber.y,
          angle: this.playerSaber.angle,
          hp: this.playerSaber.hp,
        });
      }
      requestAnimationFrame(sendState);
    };
    sendState();
  }

  _trackMouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    this.mouseX = (e.clientX - rect.left) * scaleX;
    this.mouseY = (e.clientY - rect.top) * scaleY;
  }

  _trackTouch(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    this.mouseX = (touch.clientX - rect.left) * scaleX;
    this.mouseY = (touch.clientY - rect.top) * scaleY;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.scale(dpr, dpr);
    if (this.ai) this.ai.setCenter(w * 0.65, h * 0.4);
  }
}
