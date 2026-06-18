export class BetaDistribution {
  alpha: number;
  beta: number;

  constructor(alpha = 1, beta = 1) {
    this.alpha = alpha;
    this.beta = beta;
  }

  /**
   * Sample from the Beta distribution using Gamma sampling.
   * Improved: uses Marsaglia & Tsang method correctly (the previous
   * Box-Muller approximation was inaccurate for small shape values).
   */
  sample(): number {
    const alphaSample = this.sampleGamma(this.alpha);
    const betaSample = this.sampleGamma(this.beta);
    return alphaSample / (alphaSample + betaSample);
  }

  private sampleGamma(shape: number): number {
    if (shape < 1) {
      // For shape < 1, use the relation: Gamma(a) = Gamma(a+1) * U^(1/a)
      const u = Math.random();
      return Math.pow(u, 1 / shape) * this.sampleGamma(shape + 1);
    }
    // Marsaglia & Tsang method (2000) — accurate for shape >= 1
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number;
      let v: number;
      do {
        // Use Box-Muller for normal distribution (more accurate than sum of uniforms)
        const u1 = Math.random();
        const u2 = Math.random();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /**
   * Update the distribution with an observation.
   * taskDifficulty (0-1) scales the update magnitude — harder tasks
   * contribute less to avoid penalizing strategies for difficult work.
   */
  update(success: boolean, taskDifficulty: number = 0.5): void {
    // Scale update by difficulty: easy tasks give stronger signal
    const weight = 0.5 + (1 - taskDifficulty) * 0.5; // [0.5, 1.0]
    if (success) {
      this.alpha += weight;
    } else {
      this.beta += weight;
    }
  }

  get mean(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  get totalTrials(): number {
    return this.alpha + this.beta - 2;
  }

  /**
   * UCB1-style exploration bonus.
   * Encourages trying strategies with fewer samples.
   * Returns a bonus value to add to the Thompson sample.
   */
  explorationBonus(totalSamples: number): number {
    if (this.totalTrials === 0) return 1.0; // Max exploration for untried strategies
    return Math.sqrt((2 * Math.log(Math.max(1, totalSamples))) / this.totalTrials);
  }
}
