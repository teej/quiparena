/** The reducer hashes a model id to `hsl(h 62% 58%)`. Keep the hue, drop the saturation,
 *  so eight model colors sit in the same desaturated family as the rest of the page. */
export function softColor(hsl: string, saturation = 40, lightness = 70): string {
  const match = /hsl\((\d+)/.exec(hsl);
  return match ? `hsl(${match[1]} ${saturation}% ${lightness}%)` : hsl;
}
