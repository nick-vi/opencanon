export function admittedJobs(requestJson: string): string {
  const request = JSON.parse(requestJson) as { jobs: unknown[]; capacity: number };
  return JSON.stringify({ accepted: true, activeCount: request.jobs.length, requestedCount: request.jobs.length, capacity: request.capacity });
}

export function emptyPruneResult(): string {
  return JSON.stringify({ deletedRuns: 0, deletedEvents: 0, retainedTerminalRuns: 0 });
}

export function assignedJobEvent(requestJson: string, sequence = 1): string {
  const request = JSON.parse(requestJson) as { event: Record<string, unknown> };
  return JSON.stringify({ ...request.event, sequence });
}

export function assignedProtocolEvent(requestJson: string, sequence = 1): string {
  const request = JSON.parse(requestJson) as { event: Record<string, unknown> };
  return JSON.stringify({ ...request.event, sequence });
}

export function emptyProtocolEventWindow(): string {
  return JSON.stringify({ events: [], latestSequence: 0 });
}

export function initialProjectPublication(): string {
  return JSON.stringify({
    revision: 1,
    activeCodeGraphGeneration: "initial",
    publishedAt: "2026-07-16T14:00:00.000Z",
  });
}

export function assignedProjectPublication(requestJson: string, sequence = 1): string {
  const request = JSON.parse(requestJson) as {
    revision: number;
    codeGraphGeneration?: string;
    protocolEvent: Record<string, unknown> & { timestamp: string };
  };
  return JSON.stringify({
    publication: {
      revision: request.revision,
      activeCodeGraphGeneration: request.codeGraphGeneration ?? "initial",
      publishedAt: request.protocolEvent.timestamp,
    },
    event: { ...request.protocolEvent, sequence },
  });
}
