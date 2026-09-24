export const formatZoomPercentage = (zoom: number): string =>
  `${Math.round(zoom * 100)}%`;

export const parseZoomPercentage = (input: string): number | null => {
  const value = input.trim();
  const match = value.match(/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/);

  if (!match) {
    return null;
  }

  const percentage = Number(value.replace(/\s*%$/, ""));
  return Number.isFinite(percentage) ? percentage : null;
};
