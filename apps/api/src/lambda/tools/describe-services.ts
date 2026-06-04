import {
  ECSClient,
  DescribeServicesCommand,
} from "@aws-sdk/client-ecs";

const ecs = new ECSClient({ region: process.env.AWS_REGION });
const STAGE = process.env.STAGE!;
const CLUSTER = `trellis-${STAGE}`;
const SERVICE = `trellis-${STAGE}-api`;

export const handler = async () => {
  const { services } = await ecs.send(
    new DescribeServicesCommand({
      cluster: CLUSTER,
      services: [SERVICE],
    }),
  );

  const svc = services?.[0];
  if (!svc) {
    throw new Error(`Service ${SERVICE} not found in cluster ${CLUSTER}`);
  }

  return {
    serviceName: svc.serviceName,
    status: svc.status,
    runningCount: svc.runningCount,
    desiredCount: svc.desiredCount,
    deployments: svc.deployments?.map((d) => ({
      id: d.id,
      status: d.status,
      runningCount: d.runningCount,
      desiredCount: d.desiredCount,
      taskDefinition: d.taskDefinition,
      rolloutState: d.rolloutState,
      createdAt: d.createdAt?.toISOString(),
    })),
    lastEvent: svc.events?.[0]
      ? {
          message: svc.events[0].message,
          createdAt: svc.events[0].createdAt?.toISOString(),
        }
      : null,
  };
};
