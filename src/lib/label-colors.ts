// Label color utilities

/** Colors that need black text for contrast (light backgrounds) */
export const LABEL_CONTRAST_LIGHT_COLORS = [
  '#eab308', // Yellow
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#f97316', // Orange
]

/**
 * Get the appropriate text color (black or white) for a label background color.
 * Uses white text for better visibility on most colors.
 */
export function getLabelTextColor(bgColor: string): 'black' | 'white' {
  return LABEL_CONTRAST_LIGHT_COLORS.includes(bgColor) ? 'black' : 'white'
}

/** Mark color palette, shared by the mark picker and Settings → Marks. */
export const LABEL_COLORS = [
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Gray', value: '#6b7280' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Lime', value: '#84cc16' },
] as const

/** Default color of a new mark (yellow). */
export const DEFAULT_MARK_COLOR = '#eab308'
