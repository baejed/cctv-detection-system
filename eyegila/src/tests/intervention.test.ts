import { describe, it, expect } from 'vitest';
import {
  INTERVENTION_CHIP,
  interventionConfidencePercent,
} from '../components/recommendations/RecommendationsTable';
import type { InterventionClass } from '../types';

const ALL_CLASSES: InterventionClass[] = ['signalize', 'road_widening', 'timing_only'];

describe('INTERVENTION_CHIP', () => {
  it('has an entry for every InterventionClass the CNN can output', () => {
    for (const c of ALL_CLASSES) {
      expect(INTERVENTION_CHIP[c]).toBeDefined();
    }
  });

  it('uses distinct human-readable labels per class', () => {
    const labels = ALL_CLASSES.map(c => INTERVENTION_CHIP[c].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it('uses distinct icons per class', () => {
    const icons = ALL_CLASSES.map(c => INTERVENTION_CHIP[c].Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('signalize is the emerald-themed action chip', () => {
    expect(INTERVENTION_CHIP.signalize.label).toBe('Signalize');
    expect(INTERVENTION_CHIP.signalize.className).toMatch(/emerald/);
  });

  it('road_widening is the amber capex warning chip', () => {
    expect(INTERVENTION_CHIP.road_widening.label).toBe('Widen');
    expect(INTERVENTION_CHIP.road_widening.className).toMatch(/amber/);
  });

  it('timing_only is the muted no-op chip', () => {
    expect(INTERVENTION_CHIP.timing_only.label).toBe('Timing');
    expect(INTERVENTION_CHIP.timing_only.className).toMatch(/muted-foreground/);
  });
});

describe('interventionConfidencePercent()', () => {
  it('rounds the [0, 1] probability to an integer percent', () => {
    expect(interventionConfidencePercent(0)).toBe(0);
    expect(interventionConfidencePercent(1)).toBe(100);
    expect(interventionConfidencePercent(0.815)).toBe(82);
    expect(interventionConfidencePercent(0.5)).toBe(50);
  });

  it('rounds half to even/up consistently with Math.round', () => {
    expect(interventionConfidencePercent(0.005)).toBe(1);
    expect(interventionConfidencePercent(0.004)).toBe(0);
  });

  it('floors below zero to a negative percent (callers should clamp upstream)', () => {
    // Confidence should never be negative on the wire, but documenting the
    // contract avoids silent surprises if a future bug puts a NaN/negative in.
    expect(interventionConfidencePercent(-0.01)).toBe(-1);
  });
});
