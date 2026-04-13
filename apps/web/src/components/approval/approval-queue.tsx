type BeeApproval = {
  id: string;
  title: string;
  bee: string;
  risk: "medium" | "high";
  reason: string;
};

export function ApprovalQueue({ pending }: { pending: BeeApproval[] }) {
  return (
    <section className="panel approval-panel">
      <header className="approval-header">
        <h2>Manager Checkpoint</h2>
        <span>{pending.length} waiting</span>
      </header>
      {pending.length === 0 ? (
        <p className="approval-empty">No items require manager review.</p>
      ) : (
        <ul className="approval-list">
          {pending.map((item) => (
            <li key={item.id} className="approval-item">
              <div>
                <strong>{item.title}</strong>
                <p>{item.reason}</p>
                <small>
                  Bee: {item.bee} / Risk: {item.risk.toUpperCase()}
                </small>
              </div>
              <button type="button">Review</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
