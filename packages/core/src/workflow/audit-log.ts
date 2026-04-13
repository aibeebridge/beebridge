export interface AuditEvent {
  type: string;
  payload: Record<string, unknown>;
  at?: string;
}

export class AuditLog {
  private readonly events: AuditEvent[] = [];

  public record(event: AuditEvent): void {
    this.events.push({ ...event, at: event.at ?? new Date().toISOString() });
  }

  public list(): AuditEvent[] {
    return [...this.events].reverse();
  }

  public snapshot(): AuditEvent[] {
    return [...this.events];
  }

  public replaceAll(events: AuditEvent[]): void {
    this.events.length = 0;
    for (const event of events) {
      this.events.push({ ...event, at: event.at ?? new Date().toISOString() });
    }
  }
}
