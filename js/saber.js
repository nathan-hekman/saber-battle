// Saber physics: spring-damper system for smooth, weighty motion
export class Saber {
  constructor(color1, color2, side = 'player') {
    // tip and handle track separately for blade flex
    this.x = 400; this.y = 400;
    this.angle = 0;
    this.length = 220;
    this.width = 4;
    // Physics state
    this.vx = 0; this.vy = 0;
    this.va = 0; // angular velocity
    this.targetX = 400; this.targetY = 400;
    this.targetAngle = 0;
    // Colors
    this.color1 = color1; // core
    this.color2 = color2; // glow
    this.side = side;
    // Combat
    this.hp = 100;
    this.blocking = false;
    this.attacking = false;
    this.attackTimer = 0;
    this.hitFlash = 0;
    // Trail history
    this.trail = [];
    this.maxTrail = 12;
  }

  setTarget(x, y) {
    this.targetX = x;
    this.targetY = y;
    // Angle from velocity direction
    const dx = x - this.x;
    const dy = y - this.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      this.targetAngle = Math.atan2(dy, dx) + Math.PI / 2;
    }
  }

  update() {
    // Spring-damper: acceleration proportional to distance, damped by velocity
    const spring = 0.12;
    const damping = 0.75;
    const ax = (this.targetX - this.x) * spring;
    const ay = (this.targetY - this.y) * spring;
    this.vx = (this.vx + ax) * damping;
    this.vy = (this.vy + ay) * damping;
    this.x += this.vx;
    this.y += this.vy;

    // Angular spring
    let da = this.targetAngle - this.angle;
    // Normalize to -PI..PI
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.va = (this.va + da * 0.1) * 0.8;
    this.angle += this.va;

    // Trail
    this.trail.push({ x: this.x, y: this.y, angle: this.angle });
    if (this.trail.length > this.maxTrail) this.trail.shift();

    if (this.attackTimer > 0) this.attackTimer--;
    if (this.hitFlash > 0) this.hitFlash--;
  }

  // Returns [tipX, tipY, baseX, baseY]
  getEndpoints() {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    return [
      this.x + cos * (this.length / 2),
      this.y + sin * (this.length / 2),
      this.x - cos * (this.length / 2),
      this.y - sin * (this.length / 2),
    ];
  }

  draw(ctx) {
    const [tx, ty, bx, by] = this.getEndpoints();

    ctx.save();

    // Trail (motion blur)
    for (let i = 0; i < this.trail.length - 1; i++) {
      const t = this.trail[i];
      const alpha = (i / this.trail.length) * 0.08;
      const cos = Math.cos(t.angle), sin = Math.sin(t.angle);
      const ttx = t.x + cos * (this.length / 2);
      const tty = t.y + sin * (this.length / 2);
      const tbx = t.x - cos * (this.length / 2);
      const tby = t.y - sin * (this.length / 2);
      ctx.beginPath();
      ctx.moveTo(ttx, tty);
      ctx.lineTo(tbx, tby);
      ctx.strokeStyle = this.color2.replace('1)', `${alpha})`);
      ctx.lineWidth = 8;
      ctx.stroke();
    }

    // Multi-pass glow (outer → inner)
    const passes = [
      { width: 28, alpha: 0.04 },
      { width: 16, alpha: 0.12 },
      { width: 8,  alpha: 0.3  },
      { width: 4,  alpha: 0.6  },
      { width: 2,  alpha: 1.0  },
    ];

    for (const pass of passes) {
      const grad = ctx.createLinearGradient(bx, by, tx, ty);
      const col = pass.alpha < 0.3 ? this.color2 : this.color1;
      grad.addColorStop(0, col.replace('1)', `0)`));
      grad.addColorStop(0.15, col.replace('1)', `${pass.alpha})`));
      grad.addColorStop(0.85, col.replace('1)', `${pass.alpha})`));
      grad.addColorStop(1, col.replace('1)', '0)'));
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = grad;
      ctx.lineWidth = pass.width;
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'lighter';
      ctx.stroke();
    }

    // Hit flash
    if (this.hitFlash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255,255,255,${this.hitFlash / 10})`;
      ctx.lineWidth = 20;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Handle (hilt)
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(this.angle);
    const hiltGrad = ctx.createLinearGradient(-3, -18, 3, 18);
    hiltGrad.addColorStop(0, '#888');
    hiltGrad.addColorStop(0.5, '#ddd');
    hiltGrad.addColorStop(1, '#555');
    ctx.fillStyle = hiltGrad;
    ctx.fillRect(-4, -14, 8, 28);
    ctx.fillStyle = '#aaa';
    ctx.fillRect(-7, -3, 14, 6);
    ctx.restore();

    ctx.restore();
  }

  // Check if two sabers are intersecting (line-segment intersection)
  static intersects(a, b) {
    const [ax1, ay1, ax2, ay2] = a.getEndpoints();
    const [bx1, by1, bx2, by2] = b.getEndpoints();
    return Saber._segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2);
  }

  static _segmentsIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
    const d1x = p2x - p1x, d1y = p2y - p1y;
    const d2x = p4x - p3x, d2y = p4y - p3y;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 0.001) return false;
    const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / cross;
    const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / cross;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
}
