export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status = 503, retryAfter = 0 } = {}) {
    super(message); this.code = code; this.retryable = retryable; this.status = status; this.retryAfter = retryAfter;
  }
}

const LOCAL_FEEDBACK = {
  APP_RATE: 'A little too fast. Give the archive a moment.',
  SOLVE_COOLDOWN: 'Take a moment to compare your clues, then try again.',
  WRONG_ANSWER: 'The lock is still closed. Compare your crew’s clues and try again.',
  STALE_ACTION: 'Your crew has moved ahead. Refresh the current room and try again.',
  SEARCH_INPUT: 'Use 2–100 characters to search for a film, book or artist.',
  PROFILE_INPUT: 'Each player needs two to four confirmed favourites.',
  IMAGE_UNAVAILABLE: 'Artwork is unavailable for this title.',
  ARTWORK_BUSY: 'Artwork is busy. The title is still available.',
};
const DIAGNOSES = {
  QLOO_CONFIG: 'Configure the server credential, then run npm run doctor.',
  QLOO_AUTH: 'Check the server credential and its expiration with npm run doctor.',
  QLOO_HOST: 'Check the server Qloo host configuration with npm run doctor.',
  HARNESS_MISSING: 'Install locked dependencies with npm ci, then run npm run doctor.',
  HARNESS_CONNECTION: 'Check the harness installation and server DNS with npm run doctor.',
  HARNESS_CLOSED: 'The harness is stopping; check the server lifecycle.',
  QLOO_CLOSED: 'Research is stopping; check the server lifecycle.',
  QLOO_SEARCH: 'Search failed; check server connectivity with npm run doctor.',
  QLOO_CONTRACT: 'Check the installed harness schema and provider contract.',
  QLOO_TIMEOUT: 'The provider deadline elapsed; check server connectivity and provider response time.',
  QLOO_TRANSPORT: 'The provider transport failed; check server DNS with npm run doctor.',
  QLOO_CONNECTION_CLOSED: 'The provider connection closed; an explicit retry will reconnect.',
  QLOO_ALLOWANCE: 'The durable provider allowance was reached.',
  QLOO_LOCAL_RATE: 'The process-minute provider allowance was reached.',
  QLOO_BUDGET: 'The research job request budget was reached.',
  QLOO_BUSY: 'The provider admission queue is full.',
  QLOO_CIRCUIT_OPEN: 'The durable provider recovery circuit is open.',
  QLOO_INCOMPLETE: 'The provider returned partial or degraded research.',
  QLOO_METADATA: 'Optional entity metadata could not be loaded.',
  QLOO_NEEDS_INPUT: 'The provider needs more specific confirmed entity signals.',
};

// Never forward raw upstream error text, credentials, commands or stack traces to players/logs.
export function providerFeedback(error) {
  if (Object.hasOwn(LOCAL_FEEDBACK, error.code)) return { code: error.code, message: LOCAL_FEEDBACK[error.code], diagnosis: null };
  const code = Object.hasOwn(DIAGNOSES, error.code) ? error.code : 'QLOO_ERROR';
  const message = code === 'QLOO_NEEDS_INPUT' ? 'Choose more specific matches for your favourites, then try again.'
    : ['QLOO_ALLOWANCE', 'QLOO_LOCAL_RATE', 'QLOO_BUDGET', 'QLOO_BUSY', 'QLOO_CIRCUIT_OPEN'].includes(code) ? 'Research is taking a short break. Your crew and favourites are saved. Please try again later.'
    : 'Research is unavailable right now. Your crew and favourites are saved. Please try again shortly.';
  return { code, message, diagnosis: DIAGNOSES[code] || 'Provider research failed. Run npm run doctor on the server for a redacted diagnosis.' };
}
