import type { Provenance } from '@pitwall/shared';

const PROV_COLOR: Record<string, string> = {
  REPORTED: 'var(--prov-reported)',
  ILLUSTRATIVE: 'var(--prov-illustrative)',
  ASSUMED: 'var(--prov-assumed)',
  UNCALIBRATED: 'var(--prov-uncalibrated)',
  UNVERIFIED: 'var(--prov-unverified)',
  FITTED: 'var(--prov-fitted)',
};

export function ProvenanceBadge({ p }: { p: Provenance | string }) {
  return (
    <span className="badge" style={{ color: PROV_COLOR[p] ?? 'var(--muted)' }} title={`provenance: ${p}`}>
      {p}
    </span>
  );
}

export function Badge({ children, color = 'var(--muted)', filled = false, title }: { children: React.ReactNode; color?: string; filled?: boolean; title?: string }) {
  return (
    <span className="badge" title={title} style={filled ? { background: color, color: '#0e1013', borderColor: color } : { color }}>
      {children}
    </span>
  );
}

export function TriggerBadge({ trigger }: { trigger: string }) {
  if (trigger === 'caution') return <Badge color="var(--caution)" filled>CAUTION</Badge>;
  if (trigger === 'weather') return <Badge color="var(--b1)">WEATHER</Badge>;
  return <Badge>{trigger.toUpperCase()}</Badge>;
}

export const WORLD_COLOR = { OPT: 'var(--opt)', B1: 'var(--b1)', B0: 'var(--b0)' } as const;
