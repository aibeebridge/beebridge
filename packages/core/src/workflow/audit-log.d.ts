export interface AuditEvent {
    type: string;
    payload: Record<string, unknown>;
    at?: string;
}
export declare class AuditLog {
    private readonly events;
    record(event: AuditEvent): void;
    list(): AuditEvent[];
}
