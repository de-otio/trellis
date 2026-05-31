const API_DOMAIN = process.env.API_DOMAIN!;

export const handler = async () => {
  const url = `https://${API_DOMAIN}/health`;
  const start = Date.now();

  const response = await fetch(url);
  const responseTimeMs = Date.now() - start;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }

  return {
    statusCode: response.status,
    responseTimeMs,
    body,
  };
};
