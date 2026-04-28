// AI opponent — finite state machine with weighted random transitions
export class AIOpponent {
  constructor(saber) {
    this.saber = saber;
    this.state = 'circle'; // circle | attack | defend | retreat
    this.stateTimer = 0;
    this.targetX = 400;
    this.targetY = 300;
    this.orbitAngle = 0;
    this.orbitRadius = 200;
    this.orbitSpeed = 0.018;
    this.difficulty = 0.7; // 0..1, scales reaction speed + accuracy
    this.reactionDelay = Math.round((1 - this.difficulty) * 30);
    this._playerSaber = null;
    this._pendingTarget = null;
    this._pendingTimer = 0;
    this._centerX = 400;
    this._centerY = 300;
  }

  setCenter(cx, cy) {
    this._centerX = cx;
    this._centerY = cy;
  }

  linkPlayer(playerSaber) {
    this._playerSaber = playerSaber;
  }

  setDifficulty(d) {
    this.difficulty = d;
    this.reactionDelay = Math.round((1 - d) * 40);
    this.orbitSpeed = 0.01 + d * 0.02;
  }

  update() {
    this.stateTimer--;
    if (this.stateTimer <= 0) this._chooseState();

    // Reaction delay: queue target updates
    if (this._pendingTimer > 0) {
      this._pendingTimer--;
    } else if (this._pendingTarget) {
      this.targetX = this._pendingTarget.x;
      this.targetY = this._pendingTarget.y;
      this._pendingTarget = null;
    }

    switch (this.state) {
      case 'circle':   this._doCircle();  break;
      case 'attack':   this._doAttack();  break;
      case 'defend':   this._doDefend();  break;
      case 'retreat':  this._doRetreat(); break;
    }

    this.saber.setTarget(this.targetX, this.targetY);
    this.saber.update();
  }

  _chooseState() {
    const hp = this.saber.hp;
    // Weight states by HP
    const weights = {
      circle:  1.5,
      attack:  hp > 30 ? 2 : 0.5,
      defend:  hp < 40 ? 2 : 0.8,
      retreat: hp < 20 ? 2 : 0.2,
    };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [state, w] of Object.entries(weights)) {
      r -= w;
      if (r <= 0) { this.state = state; break; }
    }
    this.stateTimer = 40 + Math.random() * 80;
  }

  _queueTarget(x, y) {
    this._pendingTarget = { x, y };
    this._pendingTimer = this.reactionDelay;
  }

  _doCircle() {
    this.orbitAngle += this.orbitSpeed;
    const r = this.orbitRadius + Math.sin(this.orbitAngle * 2.3) * 40;
    this._queueTarget(
      this._centerX + Math.cos(this.orbitAngle) * r,
      this._centerY + Math.sin(this.orbitAngle) * r * 0.6 - 40
    );
  }

  _doAttack() {
    if (!this._playerSaber) return this._doCircle();
    // Aim for a point near the player saber center, offset to simulate thrust
    const noise = (1 - this.difficulty) * 80;
    this._queueTarget(
      this._playerSaber.x + (Math.random() - 0.5) * noise,
      this._playerSaber.y + (Math.random() - 0.5) * noise
    );
  }

  _doDefend() {
    // Move to interpose between player and AI center
    if (!this._playerSaber) return this._doCircle();
    const mx = (this._playerSaber.x + this._centerX) / 2;
    const my = (this._playerSaber.y + this._centerY) / 2;
    this._queueTarget(mx, my);
  }

  _doRetreat() {
    if (!this._playerSaber) return this._doCircle();
    const dx = this._centerX - this._playerSaber.x;
    const dy = this._centerY - this._playerSaber.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    this._queueTarget(
      this._centerX + (dx / len) * 120,
      this._centerY + (dy / len) * 80
    );
  }
}
