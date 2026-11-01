// Сравнение версий вида 0.3.2 / v0.3.2. Пре-релизы на GitHub (0.4.0-rc.1) пользователям не предлагаются,
// а итоговая версия новее своей беты: у тестера с 0.4.0-beta.1 программа предложит 0.4.0.
function parts(v: string): { n: number[]; pre: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b || a.pre) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] > b.n[i];
  return b.pre;
}
