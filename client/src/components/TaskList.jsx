function TaskList({ tasks, onDelete }) {
  if (tasks.length === 0) {
    return <div className="empty-state">No reminders yet</div>;
  }

  const formatDateTime = (isoString) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  };

  const calculateOverdue = (overdueSinceISO, intervalType) => {
    const diffMs = new Date() - new Date(overdueSinceISO);
    if (intervalType === 'minutes') {
      return `${Math.floor(diffMs / 60000)} min`;
    }
    const days = Math.floor(diffMs / 86400000);
    return days === 0 ? '< 1 day' : `${days} day(s)`;
  };

  return (
    <div className="task-list">
      {tasks.map((task) => {
        const isPending = task.status === 'pending_reply';
        const interval = task.intervalType === 'minutes'
          ? `Every ${task.intervalValue} min`
          : `Every ${task.intervalValue} day${task.intervalValue > 1 ? 's' : ''}`;

        return (
          <div key={task.id} className="task-item" style={{ borderLeft: isPending ? '3px solid #f59e0b' : '3px solid transparent' }}>
            <div className="task-info">
              <h3>{task.name}</h3>
              <div className="task-meta">
                <span>{task.phone}</span>
                <span>•</span>
                <span>{interval}</span>
              </div>
              <div className="task-status" style={{ fontSize: '0.75rem', marginTop: '4px', color: isPending ? '#d97706' : '#6b7280' }}>
                {isPending ? (
                  <>⚠️ Waiting for reply (Overdue: {calculateOverdue(task.overdueSince, task.intervalType)})</>
                ) : (
                  <>📅 Next reminder: {formatDateTime(task.nextReminder)}</>
                )}
              </div>
            </div>
            <button className="btn-remove" onClick={() => onDelete(task.id)}>
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default TaskList;
