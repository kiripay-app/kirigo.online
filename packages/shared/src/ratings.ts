export const MIN_RATINGS_SHOWN = 5;

/** What to show for someone's rating: "New" until 5 ratings. */
export function displayRating(avg: number | null, count: number): string {
  if (count < MIN_RATINGS_SHOWN || avg == null) return 'New';
  return avg.toFixed(1);
}

export interface FlagRule { below: number; after: number }
export const FLAG_RULES: Record<'driver' | 'customer' | 'shop', FlagRule> = {
  driver: { below: 3.5, after: 20 },
  customer: { below: 3.0, after: 5 },
  shop: { below: 3.5, after: 20 },
};

/** Patterns only: never flag on a few ratings. */
export function shouldFlag(kind: keyof typeof FLAG_RULES, avg: number | null, count: number): boolean {
  const r = FLAG_RULES[kind];
  return avg != null && count >= r.after && avg < r.below;
}

/** New running average after adding one rating. */
export function addToAverage(avg: number | null, count: number, stars: number): { avg: number; count: number } {
  const total = (avg ?? 0) * count + stars;
  return { avg: Math.round((total / (count + 1)) * 100) / 100, count: count + 1 };
}
