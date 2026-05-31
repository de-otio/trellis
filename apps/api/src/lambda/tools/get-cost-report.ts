import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

const ce = new CostExplorerClient({ region: "us-east-1" });

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const handler = async (event: { days?: number }) => {
  const days = Math.min(Math.max(event.days ?? 7, 1), 30);

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);

  const { ResultsByTime } = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: formatDate(start),
        End: formatDate(end),
      },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }),
  );

  let totalCost = 0;
  let currency = "USD";
  const dailyTotals: { date: string; cost: number }[] = [];
  const serviceMap = new Map<string, number>();

  for (const period of ResultsByTime ?? []) {
    let dayTotal = 0;
    for (const group of period.Groups ?? []) {
      const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "0");
      currency = group.Metrics?.UnblendedCost?.Unit ?? "USD";
      dayTotal += amount;

      const serviceName = group.Keys?.[0] ?? "Unknown";
      serviceMap.set(serviceName, (serviceMap.get(serviceName) ?? 0) + amount);
    }
    totalCost += dayTotal;
    dailyTotals.push({
      date: period.TimePeriod?.Start ?? "unknown",
      cost: Math.round(dayTotal * 100) / 100,
    });
  }

  const byService = Array.from(serviceMap.entries())
    .map(([service, cost]) => ({ service, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    currency,
    days,
    dailyTotals,
    byService,
  };
};
