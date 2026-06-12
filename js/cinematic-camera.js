const CinematicCamera = {
  zoom: 1,
  panX: 0,
  panY: 0,
  tilt: 0,
  targetZoom: 1,
  targetPanX: 0,
  targetPanY: 0,
  targetTilt: 0,

  reset() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.tilt = 0;
    this.targetZoom = 1;
    this.targetPanX = 0;
    this.targetPanY = 0;
    this.targetTilt = 0;
  },

  update(p, energy, transitionEase = 0, revival = null) {
    const t = p.frameCount;
    const bass = energy ? energy.bass : 0.15;
    const e = energy ? energy.energy : 0.15;
    const smooth = revival?.intensity > 0.3 ? 0.12 : 0.04;
    const punch = revival ? revival.punchZoom * 0.14 : 0;

    const driftX = Math.sin(t * 0.006) * 18 + Math.sin(t * 0.013) * 8;
    const driftY = Math.cos(t * 0.007) * 12 + Math.cos(t * 0.011) * 6;
    const breathe = Math.sin(t * 0.004) * 0.012;

    this.targetPanX = driftX * (0.4 + e * 0.6);
    this.targetPanY = driftY * (0.4 + e * 0.6);
    this.targetTilt = Math.sin(t * 0.005) * 0.018 * (0.5 + e);
    this.targetZoom = 1 + breathe + bass * 0.03 + punch - transitionEase * 0.02;

    this.panX += (this.targetPanX - this.panX) * smooth;
    this.panY += (this.targetPanY - this.panY) * smooth;
    this.tilt += (this.targetTilt - this.tilt) * smooth;
    this.zoom += (this.targetZoom - this.zoom) * smooth;
  },

  apply(p) {
    const cx = p.width / 2;
    const cy = p.height / 2;
    p.translate(cx + this.panX, cy + this.panY);
    p.scale(this.zoom);
    p.rotate(this.tilt);
    p.translate(-cx, -cy);
  },
};
