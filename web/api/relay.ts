// Vercel serverless function: POST /api/relay with a SignedPresentation (bigints as strings).
import { envFromProcess, relayPresentation } from "./_relay-core";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const r = await relayPresentation(body, envFromProcess());
  return Response.json(r.body, { status: r.status });
}
