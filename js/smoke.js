// Smoke particle system with curl noise for fluid-like motion
class Particle {
  constructor(x, y, vx, vy, color, life) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.color = color;
    this.life = life;
    this.maxLife = life;
    this.size = Math.random() * 18 + 8;
    this.rotation = Math.random() * Math.PI * 2;
    this.spin = (Math.random() - 0.5) * 0.04;
  }
}

export class SmokeSystem {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.time = 0;
  }

  // Curl noise: rotate the gradient of a simplex-like field 90° → divergence-free flow
  _curl(x, y, t) {
    const eps = 0.01;
    const s = 0.003;
    const n1 = this._noise(x * s, y * s, t);
    const n2 = this._noise((x + eps) * s, y * s, t);
    const n3 = this._noise(x * s, (y + eps) * s, t);
    return { vx: (n3 - n1) / eps, vy: -(n2 - n1) / eps };
  }

  // Smooth pseudo-random (value noise, no dep on external lib)
  _noise(x, y, t) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const r = (a, b, c) => Math.sin(a * 127.1 + b * 311.7 + c * 74.3) * 43758.5453;
    const frac = v => v - Math.floor(v);
    const h00 = frac(Math.abs(r(ix, iy, t)));
    const h10 = frac(Math.abs(r(ix + 1, iy, t)));
    const h01 = frac(Math.abs(r(ix, iy + 1, t)));
    const h11 = frac(Math.abs(r(ix + 1, iy + 1, t)));
    return h00 + ux * (h10 - h00) + uy * (h01 - h00) + ux * uy * (h00 - h10 - h01 + h11);
  }

  emit(x, y, color, count = 3, speed = 1.5) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = Math.random() * speed;
      this.particles.push(new Particle(
        x + (Math.random() - 0.5) * 10,
        y + (Math.random() - 0.5) * 10,
        Math.cos(angle) * spd,
        Math.sin(angle) * spd - 0.4, // slight upward drift
        color,
        60 + Math.random() * 40
      ));
    }
    // Cap particle count
    if (this.particles.length > 600) {
      this.particles.splice(0, this.particles.length - 600);
    }
  }

  update() {
    this.time += 0.008;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const curl = this._curl(p.x, p.y, this.time);
      p.vx += curl.vx * 0.6;
      p.vy += curl.vy * 0.6;
      // Drag
      p.vx *= 0.97;
      p.vy *= 0.97;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      p.life--;
      p.size += 0.15;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      const alpha = (p.life / p.maxLife) * 0.45;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
      gradient.addColorStop(0, p.color.replace('1)', `${alpha})`));
      gradient.addColorStop(1, p.color.replace('1)', '0)'));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(0, 0, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}
