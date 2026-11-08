export function upFor(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `Up ${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `Up ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return "Just started";
}

export function timeLeft(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days < 1) return "full within a day";
  if (days < 14) return `about ${Math.round(days)} ${Math.round(days) === 1 ? "day" : "days"} left`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks left`;
  if (days < 730) return `about ${Math.round(days / 30.4)} months left`;
  return null;
}
