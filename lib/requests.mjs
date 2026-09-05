/** A CLI prompt supplies one new turn, never a replacement conversation history. */
export function buildPromptRequest({ prompt, flowIds = [] } = {}) {
  if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > 1024 * 1024
    || !Array.isArray(flowIds) || flowIds.length > 1) {
    throw new Error('Use a prompt below 1 MiB and at most one flow.');
  }
  return { ...(flowIds[0] ? { model: flowIds[0] } : {}), stream: false,
    metadata: { appendMessages: 'true' },
    messages: [{ role: 'user', content: prompt }] };
}
