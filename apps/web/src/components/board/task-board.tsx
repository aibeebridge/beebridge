type TaskStatus = "queued" | "assigned" | "working" | "checking" | "done";

type TaskCard = {
  id: string;
  title: string;
  districtName: string;
  bee: string;
  flower: string;
  priority: "low" | "medium" | "high";
  status: TaskStatus;
  dueDate: string;
  estimate: string;
};

const statusOrder: TaskStatus[] = ["queued", "assigned", "working", "checking", "done"];

const statusLabels: Record<TaskStatus, string> = {
  queued: "Planned",
  assigned: "Assigned",
  working: "Building",
  checking: "Manager Review",
  done: "Built",
};

function priorityLabel(priority: TaskCard["priority"]): string {
  if (priority === "high") return "High";
  if (priority === "low") return "Low";
  return "Medium";
}

export function TaskBoard({ tasks, cityName }: { tasks: TaskCard[]; cityName: string }) {
  const byStatus = statusOrder.map((status) => ({
    status,
    label: statusLabels[status],
    items: tasks.filter((task) => task.status === status),
  }));

  return (
    <section className="panel planner-board">
      <div className="planner-board-header">
        <div>
          <h2>District Task Board</h2>
          <p>{cityName}</p>
        </div>
        <div className="planner-board-stats">
          <span>{tasks.length} tasks</span>
          <span>{tasks.filter((task) => task.status === "done").length} built</span>
        </div>
      </div>

      <div className="kanban-grid">
        {byStatus.map((column) => (
          <section key={column.status} className="kanban-column">
            <header>
              <h3>{column.label}</h3>
              <span>{column.items.length}</span>
            </header>

            <div className="kanban-cards">
              {column.items.length === 0 ? (
                <p className="empty-lane">No tasks in this zone</p>
              ) : (
                column.items.map((task) => (
                  <article key={task.id} className="task-card">
                    <p className="task-story">{task.districtName}</p>
                    <strong>{task.title}</strong>
                    <div className="task-meta">
                      <span>{task.bee}</span>
                      <span>{task.estimate}</span>
                    </div>
                    <p className="flower-meta">Flower: {task.flower}</p>
                    <div className="task-tags">
                      <span className={`priority-tag ${task.priority}`}>
                        {priorityLabel(task.priority)}
                      </span>
                      <span className="due-tag">{task.dueDate}</span>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
