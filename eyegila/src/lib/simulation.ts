import type { SimulationResponse, SimulationChunk } from '@/services/simulation';

/** The chunk with the highest measured volume is what every page treats as
 *  representative. Centralised here so the "peak = max volume_pcu_hr" rule
 *  has one home. */
export function selectPeakChunk(sim: SimulationResponse | null): SimulationChunk | null {
  if (!sim || sim.chunks.length === 0) return null;
  return [...sim.chunks].sort((a, b) => b.volume_pcu_hr - a.volume_pcu_hr)[0] ?? null;
}
