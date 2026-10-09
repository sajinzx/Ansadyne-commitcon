// The only engine file allowed to read the wall clock (R2): decision latency is measured and reported,
// never used to control how much work the planner does.
export function nowMs(): number {
  return performance.now();
}
