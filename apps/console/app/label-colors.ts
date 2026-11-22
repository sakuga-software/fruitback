/**
 * The colours a new label of a task can take (FRU-654). They are data, not tokens of the console: the
 * worker keeps the one chosen with the label, as `#rrggbb`, and a screen draws it as it draws the
 * colour of a status. Each reads on the surface of the console. `parts/task-seam.tsx` names them.
 */
export const LABEL_COLORS = {
  red: '#dc2626',
  orange: '#ea580c',
  yellow: '#ca8a04',
  emerald: '#16a34a',
  teal: '#0891b2',
  blue: '#2563eb',
  purple: '#7c3aed',
  grey: '#6b7280',
} as const;

export type LabelColor = keyof typeof LABEL_COLORS;
