// utils/period.ts

export type Quarter = 1 | 2 | 3 | 4;

export const quarterOf = (date: Date = new Date()): Quarter => {
  return (Math.floor(date.getMonth() / 3) + 1) as Quarter;
};

export const previousQuarter = (q: Quarter = quarterOf(), year = new Date().getFullYear()) => {
  if (q === 1) return { q: 4 as Quarter, year: year - 1 };
  return { q: (q - 1) as Quarter, year };
};

export const ymdInQuarter = (ymd: string, q: Quarter, year: number): boolean => {
  if (!ymd || ymd.length !== 8) return false;
  const y = parseInt(ymd.substring(0, 4), 10);
  const m = parseInt(ymd.substring(4, 6), 10);
  if (y !== year) return false;
  const targetQ = Math.floor((m - 1) / 3) + 1;
  return targetQ === q;
};

export const hasVisitInQuarter = (visits: { ymd: string }[], q: Quarter = quarterOf(), year: number = new Date().getFullYear()) => {
  return visits.some(v => ymdInQuarter(v.ymd, q, year));
};

export const getQuarterStr = (date: Date = new Date()) => {
  return `${date.getFullYear()}-Q${quarterOf(date)}`;
};

export const getQuarterFromYYYYMMDD = (ymd: string) => {
  if (!ymd || ymd.length !== 8) return '';
  const y = ymd.substring(0, 4);
  const m = parseInt(ymd.substring(4, 6), 10);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
};
