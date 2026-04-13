export class AuditLog {
    events = [];
    record(event) {
        this.events.push({ ...event, at: event.at ?? new Date().toISOString() });
    }
    list() {
        return [...this.events].reverse();
    }
}
